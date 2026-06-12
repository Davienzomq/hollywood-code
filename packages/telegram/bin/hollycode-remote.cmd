@echo off
REM hollycode-remote.cmd — Windows entry point
REM Usage: hollycode-remote [--model provider/id] [--directory path]

bun run "%USERPROFILE%\.bun\bin\hollycode-remote" %*
