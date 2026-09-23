; Skills are no longer bundled into the installer. Only make sure the
; per-user data directories exist so first launch can seed them.
!macro customInstall
  CreateDirectory "$APPDATA\HyBot\data\skills"
  CreateDirectory "$APPDATA\HyBot\data\plugins"
  CreateDirectory "$APPDATA\HyBot\data\tool-market"
!macroend
