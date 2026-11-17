!macro NSIS_HOOK_POSTINSTALL
  ; An upgrade can keep the executable and shortcut paths while replacing their icon.
  ; SHCNE_UPDATEITEM (0x2000), SHCNF_PATHW (0x0005).
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x0005, w "$INSTDIR\${MAINBINARYNAME}.exe", p 0)'
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x0005, w "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x0005, w "$SMPROGRAMS\${PRODUCTNAME}.lnk", p 0)'
  ${EndIf}
!macroend
