; 墨隐 Windows 安装程序（NSIS 3，Unicode）
; 构建：makensis -DSOURCE=<程序目录> -DVERSION=2.22.0 -DOUTFILE=<输出exe> moyin.nsi
; 程序目录里应有 墨隐本地脱敏.exe 和 resources\（已用 tools/harden-win-package.cjs 加固）。

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef SOURCE
  !error "需要 -DSOURCE=程序目录"
!endif
!ifndef VERSION
  !error "需要 -DVERSION=版本号"
!endif
!ifndef OUTFILE
  !define OUTFILE "墨隐本地脱敏-${VERSION}-安装程序.exe"
!endif

!define APPNAME "墨隐"
!define APPEXE "墨隐本地脱敏.exe"
!define PUBLISHER "董建筑讲建筑财税&延承财税（建筑业）"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MoyinLocalRedaction"

Name "${APPNAME} ${VERSION}"
Caption "${APPNAME} ${VERSION} 安装"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${APPNAME}"
InstallDirRegKey HKLM "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel admin
BrandingText "${APPNAME} · 本地文档脱敏"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=2052 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APPNAME} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "${PUBLISHER}"

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "moyin.ico"
!define MUI_UNICON "moyin.ico"
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "确定要退出墨隐安装吗？"

!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APPNAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "墨隐是在本机运行的文档脱敏工具：文件不上传、不联网。$\r$\n$\r$\n安装完成后，桌面上会出现“墨隐”图标，双击即可使用。第一次打开时按提示激活。$\r$\n$\r$\n如果正在使用墨隐，请先关闭它，再点“下一步”。$\r$\n$\r$\n本软件由董建筑讲建筑财税&延承财税（建筑业）联合出品。"
!insertmacro MUI_PAGE_WELCOME

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择墨隐的安装位置。可以装在 C 盘，也可以点“浏览”换到 D 盘等其他位置（需要约 1.6 GB 空间）。$\r$\n文件仓库、授权等资料保存在你的用户目录里，不在安装位置，升级或重装都不会丢。"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "墨隐安装完成"
!define MUI_FINISHPAGE_TEXT "已在桌面和开始菜单创建“墨隐”快捷方式。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPEXE}"
!define MUI_FINISHPAGE_RUN_TEXT "现在打开墨隐"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "墨隐需要 64 位 Windows（Windows 10 或更新版本）。"
    Abort
  ${EndIf}
  SetRegView 64
  ; 已安装过：默认装回原来的位置（升级）
  ReadRegStr $0 HKLM "${UNINSTKEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

Function .onVerifyInstDir
  ; 不允许直接装在盘符根目录（如 D:\），避免卸载时清理整个盘
  StrLen $0 $INSTDIR
  ${If} $0 <= 3
    Abort
  ${EndIf}
FunctionEnd

Section "墨隐" SecMain
  SectionIn RO
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  ; 升级时先删掉旧的程序文件（资料不在这里），避免旧版本残留文件与新程序混在一起
  ${If} ${FileExists} "$INSTDIR\${APPEXE}"
    DetailPrint "正在移除旧版本程序文件…"
    Delete "$INSTDIR\${APPEXE}"
    ${If} ${FileExists} "$INSTDIR\${APPEXE}"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "墨隐正在运行，请先关闭它，然后点“重试”。" IDRETRY retry
      Abort
      retry:
      Delete "$INSTDIR\${APPEXE}"
    ${EndIf}
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    Delete "$INSTDIR\升级步骤.txt"
  ${EndIf}

  File /r "${SOURCE}\*.*"

  WriteUninstaller "$INSTDIR\卸载墨隐.exe"

  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0 SW_SHOWNORMAL "" "墨隐 · 本地文档脱敏"
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}\卸载墨隐.lnk" "$INSTDIR\卸载墨隐.exe"

  SetRegView 64
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APPNAME}（本地文档脱敏）"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${APPEXE}"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\卸载墨隐.exe"'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  Delete "$INSTDIR\${APPEXE}"
  ${If} ${FileExists} "$INSTDIR\${APPEXE}"
    MessageBox MB_ICONSTOP "墨隐正在运行，请先关闭它再卸载。"
    Abort
  ${EndIf}
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  ; 只删除安装目录里的程序文件；文件仓库、授权、备份在用户目录，不删除
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\卸载墨隐.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"
SectionEnd
