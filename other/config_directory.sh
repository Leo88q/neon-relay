#!/bin/sh
# Opens the Neon Relay user/config directory.
# Falls back to the directories used by earlier installations (DDNet, Teeworlds).
case "$(uname -s)" in
CYGWIN* | MINGW* | MSYS*)
	if [ -d "$APPDATA/NeonRelay/" ]; then
		explorer "$APPDATA/NeonRelay/"
	elif [ -d "$APPDATA/DDNet/" ]; then
		explorer "$APPDATA/DDNet/"
	else
		explorer "$APPDATA/Teeworlds/"
	fi
	;;
Darwin*)
	if [ -d "$HOME/Library/Application Support/NeonRelay/" ]; then
		open "$HOME/Library/Application Support/NeonRelay/"
	elif [ -d "$HOME/Library/Application Support/DDNet/" ]; then
		open "$HOME/Library/Application Support/DDNet/"
	else
		open "$HOME/Library/Application Support/Teeworlds/"
	fi
	;;
*)
	DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
	if [ -d "$DATA_HOME/neonrelay/" ]; then
		xdg-open "$DATA_HOME/neonrelay/"
	elif [ -d "$DATA_HOME/NeonRelay/" ]; then
		xdg-open "$DATA_HOME/NeonRelay/"
	elif [ -d "$DATA_HOME/ddnet/" ]; then
		xdg-open "$DATA_HOME/ddnet/"
	else
		xdg-open "$HOME/.teeworlds/"
	fi
	;;
esac
