Set oShell = CreateObject("WScript.Shell")
oShell.Run "cmd /c """ & Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\")) & "_push.bat""", 1, True
