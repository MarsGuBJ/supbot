; Seed bundled default data into the installing user's data directory during
; install/upgrade so skills are available before first launch. CopyFiles
; overwrites existing files, so every install resets bundled skills to the
; packaged versions. Per-user install: $APPDATA resolves to the installing
; user's Roaming folder. Other OS users and Linux builds are still covered by
; the launch-time seeding in src/main/index.ts.
!macro customInstall
  CreateDirectory "$APPDATA\HyBot\data\skills"
  CopyFiles /SILENT "$INSTDIR\resources\default-data\skills\*" "$APPDATA\HyBot\data\skills"
  CreateDirectory "$APPDATA\HyBot\data\tool-market"
  CopyFiles /SILENT "$INSTDIR\resources\default-data\tool-market\*" "$APPDATA\HyBot\data\tool-market"
!macroend
