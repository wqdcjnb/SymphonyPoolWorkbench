@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-cloud-workbench-v2.ps1"
if errorlevel 1 pause
