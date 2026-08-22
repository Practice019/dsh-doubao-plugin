// Browser half of the doubao-dsh-plugin: paste-to-path.
//
// Reuses the modlens (@liustack/modlens) paste-to-path client logic (route
// name, bundle id, log prefix changed; plus two fixes: the very first paste
// now waits for the host verdict instead of going native, and a missing
// selector label leaves the paste native instead of swallowing it).
//
// Capture-phase paste listener runs before the composer's own handler. When
// the clipboard carries image files, the host is asked whether the selected
// model is text-only (GET /doubao-paste?model=<label>); once confirmed, the
// default intake (attachment -> host image admission -> "model does not
// support images") is suppressed, the bytes go to POST /doubao-paste, land as
// a private temp file, and the returned path is inserted into the composer as
// plain text. A text-only model then sees a file path, which it can hand to
// the doubao_ask tool's `image` parameter so Doubao reads the picture.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages. The id must equal the loader entry name
// (package name), because the host serves this bundle at
// /plugins/doubao-dsh-plugin/client.js.
window.__ModuleLoader__.load({
  id: 'doubao-dsh-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    function imageFilesOf(event) {
      var items = event.clipboardData?.items
      if (!items) return []
      var files = []
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item.kind !== 'file') continue
        var file = item.getAsFile()
        if (file && /^image\//.test(file.type)) files.push(file)
      }
      return files
    }

    function insertText(target, text) {
      var el = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') ? target : document.activeElement
      if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return
      el.focus()
      // execCommand fires the input event React's controlled textarea needs;
      // the prototype-setter dance is the fallback for engines dropping it.
      var inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (!inserted) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, el.value + text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    function uploadOne(file) {
      return file.arrayBuffer().then((buffer) =>
        fetch('/doubao-paste', { method: 'POST', body: buffer }).then((res) => {
          if (!res.ok) {
            return res
              .json()
              .catch(() => ({}))
              .then((body) => {
                var error = new Error(body.error || `paste upload failed (${res.status})`)
                error.status = res.status
                throw error
              })
          }
          return res.json()
        }),
      )
    }

    function currentModelLabel() {
      var buttons = document.querySelectorAll('button[aria-label]')
      for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].getAttribute('aria-label') || ''
        if (/选择模型|select model|current model/i.test(label)) return label
      }
      return ''
    }

    // Whether to take a paste over is the HOST's call (GET /doubao-paste
    // with the selector label; the host resolves it against real model
    // metadata). The verdict is cached per label and refreshed in the
    // background. A 404 means the route is off (no web profile), so the
    // client stands down entirely.
    var routeAvailable = true
    var verdicts = {}
    var VERDICT_MAX_AGE_MS = 60000

    function refreshVerdict(label) {
      if (!routeAvailable) return
      var cached = verdicts[label]
      if (cached?.pending) return
      var entry = { pending: true, takeover: cached ? cached.takeover : false, at: cached ? cached.at : 0 }
      verdicts[label] = entry
      fetch(`/doubao-paste?model=${encodeURIComponent(label)}`)
        .then((res) => {
          if (res.status === 404) {
            routeAvailable = false
            entry.pending = false
            return null
          }
          if (!res.ok) throw new Error(`policy ${res.status}`)
          return res.json()
        })
        .then((body) => {
          entry.pending = false
          if (body) {
            entry.takeover = body.takeover === true
            entry.at = Date.now()
          }
        })
        .catch(() => {
          entry.pending = false
        })
    }

    // A paste needs the composer focused first, so a focus-time prefetch has
    // the verdict ready before the first paste can land.
    function onFocusIn() {
      refreshVerdict(currentModelLabel())
    }

    function onPaste(event) {
      if (!routeAvailable) return
      var files = imageFilesOf(event)
      if (files.length === 0) return
      var target = event.target
      var label = currentModelLabel()
      console.log(`[doubao] paste: files=${files.length} label="${label}"`)
      if (label === '') {
        // No selector label found: cannot ask the host. Leave the paste
        // native rather than swallowing it.
        console.warn('[doubao] no model label found; paste left native')
        return
      }
      var cached = verdicts[label]
      refreshVerdict(label)
      if (cached && cached.at > 0 && cached.takeover === true && Date.now() - cached.at <= VERDICT_MAX_AGE_MS) {
        takeOver(event, target, files)
        return
      }
      // No usable cached verdict yet: swallow the paste now and wait for the
      // in-flight host answer (the modlens self-correcting design costs the
      // very first paste; waiting fixes that).
      event.preventDefault()
      event.stopImmediatePropagation()
      var tries = 0
      var timer = setInterval(function () {
        var entry = verdicts[label]
        tries += 1
        if (entry && entry.pending === false) {
          clearInterval(timer)
          if (entry.at > 0 && entry.takeover === true) {
            takeOver(event, target, files)
          } else {
            console.warn(`[doubao] verdict=false (${label}); pasted image dropped`)
          }
        } else if (tries >= 50) {
          clearInterval(timer)
          console.warn(`[doubao] verdict timeout (${label}); pasted image dropped`)
        }
      }, 100)
    }

    function takeOver(event, target, files) {
      // Take the paste before the composer's intake starts an attachment (and
      // with it the host-side image admission a text-only model fails).
      event.preventDefault()
      event.stopImmediatePropagation()
      Promise.all(files.map(uploadOne))
        .then((results) => {
          var text = results
            .map((r) => r.path)
            .filter(Boolean)
            .join(' ')
          if (text) insertText(target, `${text} `)
        })
        .catch((error) => {
          // A 404 here means the route vanished AFTER a verdict confirmed it
          // (plugin disposed mid-session): stand down and forget every verdict.
          if (error && error.status === 404) {
            routeAvailable = false
            verdicts = {}
          }
          console.error(`[doubao] paste-to-path failed: ${error?.message ? error.message : error}`)
        })
    }

    function apply(ctx) {
      // Diagnostic marker: lets us verify from outside that apply() ran.
      try {
        document.documentElement.setAttribute('data-doubao-paste', '1')
      } catch {
        // non-fatal
      }
      console.log('[doubao] paste-to-path client loaded; attaching listeners')
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('focusin', onFocusIn, true)
      // cordis effect: unregister on plugin disposal (HMR, profile reload).
      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            document.removeEventListener('paste', onPaste, true)
            document.removeEventListener('focusin', onFocusIn, true)
          },
          'doubao: paste-to-path listener',
        )
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
