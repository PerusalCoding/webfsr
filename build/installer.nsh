; ── AwakenedAnimus installer customizations ─────────────────────────────────
; electron-builder auto-includes this file if `build.nsis.include` points to
; it (see package.json). These macros hook into the generated installer at
; specific points.

!macro customInit
  ; Don't play anything for silent/unattended installs (e.g. `/S` flag,
  ; enterprise deployment tools) -- audio during a scripted install is
  ; unexpected and can be actively disruptive.
  IfSilent skip_sound 0
    ; File extracts the embedded wav to a temp plugin dir at install time
    ; and plays it async so it doesn't block the installer UI.
    File /oname=$PLUGINSDIR\theme.wav "${BUILD_RESOURCES_DIR}\installer-assets\theme.wav"
    System::Call 'winmm::PlaySoundW(w "$PLUGINSDIR\theme.wav", i 0, i 0x00020001)'
    ; 0x00020001 = SND_ASYNC (0x1, don't block) | SND_FILENAME (0x20000)
  skip_sound:
!macroend
