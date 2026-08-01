' Launches a command with no visible window.
'
' Needed because OBS's Lua os.execute() goes through cmd.exe, which would leave a black
' console window in the taskbar for the whole stream. WScript.Shell.Run with window style
' 0 starts the server genuinely hidden.
'
' Usage: wscript launch-hidden.vbs "C:\path\node.exe" "C:\path\server\index.js" --obs --port 7333

Option Explicit

Dim shell, cmd, i, arg
Set shell = CreateObject("WScript.Shell")

cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If i > 0 Then cmd = cmd & " "
  ' Quote anything containing a space; leave bare flags like --obs alone.
  If InStr(arg, " ") > 0 Then
    cmd = cmd & """" & arg & """"
  Else
    cmd = cmd & arg
  End If
Next

' 0 = hidden window, False = do not wait for it to finish.
shell.Run cmd, 0, False
