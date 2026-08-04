Option Explicit

Dim shell, fso, folder, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder

command = "cmd.exe /d /s /c ""node print-helper.js >> print-helper.log 2>&1"""

' 0 = ventana oculta. False = no esperar a que termine.
shell.Run command, 0, False