Set oShell = CreateObject("WScript.Shell")
Dim dir : dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

' Remove git lock files using PowerShell (more reliable than del)
oShell.Run "powershell -Command ""Remove-Item -Force -ErrorAction SilentlyContinue '" & dir & ".git\index.lock'""", 0, True

' Run the push bat
oShell.Run "cmd /c """ & dir & "_push.bat""", 1, True
