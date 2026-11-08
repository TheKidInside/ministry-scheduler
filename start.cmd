@echo off
rem Serves the app at http://localhost:8795/ (ES modules need http, not file://)
cd /d "%~dp0"
start "" http://localhost:8795/
py -3 -m http.server 8795
