@echo off
rem Opens the Neon Relay user/config directory.
rem Falls back to the directories used by earlier installations (DDNet, Teeworlds).

if exist "%APPDATA%\NeonRelay\" (
	start explorer "%APPDATA%\NeonRelay\"
	exit /b
)

if exist "%APPDATA%\DDNet\" (
	start explorer "%APPDATA%\DDNet\"
	exit /b
)

if exist "%APPDATA%\Teeworlds\" (
	start explorer "%APPDATA%\Teeworlds\"
	exit /b
)

echo No configuration directory was found.
pause
