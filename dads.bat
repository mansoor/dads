@echo off
rem dads — Windows CLI shim that runs the PowerShell wrapper alongside it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dads.ps1" %*
