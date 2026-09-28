!include "MUI2.nsh"

!define APPNAME "Purrlor"
!define APPVERSION "1.0.0"
!define EXE_NAME "Purrlor.exe"
!define OUTFILE "..\dist\Purrlor-Setup.exe"
!define INSTALLDIR "$LOCALAPPDATA\Purrlor"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Purrlor"

; Keep the icon next to this .nsi file and run makensis from this directory.
Icon "purrlor.ico"
UninstallIcon "purrlor.ico"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "${INSTALLDIR}"
RequestExecutionLevel user
Unicode True

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "Purrlor"
VIAddVersionKey "CompanyName" "MeowOps"
VIAddVersionKey "FileDescription" "Purrlor Desktop Installer"
VIAddVersionKey "FileVersion" "${APPVERSION}"
VIAddVersionKey "ProductVersion" "${APPVERSION}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Purrlor" SEC_MAIN
  SectionIn RO
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "..\Purrlor\bin\Release\net8.0-windows\win-x64\publish\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "MeowOps"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE_NAME},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section /o "Desktop Shortcut" SEC_DESKTOP
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Purrlor.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
SectionEnd

Section "Start Menu Shortcut" SEC_STARTMENU
  SetShellVarContext current
  CreateDirectory "$SMPROGRAMS\Purrlor"
  CreateShortCut "$SMPROGRAMS\Purrlor\Purrlor.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  CreateShortCut "$SMPROGRAMS\Purrlor\Uninstall Purrlor.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Purrlor.lnk"
  Delete "$SMPROGRAMS\Purrlor\Purrlor.lnk"
  Delete "$SMPROGRAMS\Purrlor\Uninstall Purrlor.lnk"
  RMDir "$SMPROGRAMS\Purrlor"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Purrlor"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
