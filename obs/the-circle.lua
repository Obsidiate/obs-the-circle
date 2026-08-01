--[[
  The Circle — OBS launcher script.

  Add once via Tools -> Scripts -> +. From then on The Circle starts when OBS starts and
  stops when OBS stops. Nothing runs when OBS is closed, and there is no "run this first".

  Why a script rather than a native plugin: OBS embeds LuaJIT, so this needs no compiler,
  no per-platform binary and no code signing, and it hooks exactly the two events that
  matter — script_load and script_unload.

  Why the heartbeat: script_unload does not run if OBS is force-quit or crashes, so the
  kill would never happen and a background process would be orphaned. The timer below
  touches a file every few seconds; the server watches it and shuts itself down if it goes
  stale. See server/obs-mode.js.
]]

local obs = obslua

local WINDOWS = package.config:sub(1, 1) == '\\'
local SEP = WINDOWS and '\\' or '/'

local settings = {
  app_dir = '',
  node_path = '',
  port = 7333,
}

local running_pid = nil

--------------------------------------------------------------------------- util

local function join(...)
  return table.concat({ ... }, SEP)
end

local function exists(path)
  if path == nil or path == '' then return false end
  local f = io.open(path, 'r')
  if f then f:close() return true end
  return false
end

local function quote(s)
  return '"' .. tostring(s) .. '"'
end

local function log(msg)
  print('[The Circle] ' .. msg)
end

--------------------------------------------------------------------- node lookup

-- A GUI app does not reliably inherit PATH on Windows, so guessing bare `node` first
-- would fail silently for a lot of people. Probe the usual install locations instead and
-- only fall back to PATH.
local function find_node()
  local candidates
  if WINDOWS then
    local pf = os.getenv('ProgramFiles') or 'C:\\Program Files'
    local pf86 = os.getenv('ProgramFiles(x86)') or 'C:\\Program Files (x86)'
    local lad = os.getenv('LOCALAPPDATA') or ''
    candidates = {
      join(pf, 'nodejs', 'node.exe'),
      join(pf86, 'nodejs', 'node.exe'),
      join(lad, 'Programs', 'nodejs', 'node.exe'),
    }
  else
    candidates = {
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      (os.getenv('HOME') or '') .. '/.local/bin/node',
    }
  end
  for _, c in ipairs(candidates) do
    if exists(c) then return c end
  end
  return WINDOWS and 'node.exe' or 'node' -- last resort: hope it is on PATH
end

------------------------------------------------------------------- runtime files

local function runtime_dir()
  return join(settings.app_dir, '.runtime')
end

local function pid_file()
  return join(runtime_dir(), 'server.pid')
end

local function beat_file()
  return join(runtime_dir(), 'obs.heartbeat')
end

local function ensure_runtime_dir()
  if WINDOWS then
    os.execute('if not exist ' .. quote(runtime_dir()) .. ' mkdir ' .. quote(runtime_dir()))
  else
    os.execute('mkdir -p ' .. quote(runtime_dir()))
  end
end

-- Milliseconds since the epoch, to match Date.now() on the server side.
local function now_ms()
  return string.format('%d', os.time() * 1000)
end

local function write_heartbeat()
  local f = io.open(beat_file(), 'w')
  if f then
    f:write(now_ms())
    f:close()
  end
end

local function read_pid()
  local f = io.open(pid_file(), 'r')
  if not f then return nil end
  local pid = f:read('*a')
  f:close()
  pid = tostring(pid or ''):gsub('%s', '')
  return pid ~= '' and pid or nil
end

------------------------------------------------------------------ start and stop

local function server_entry()
  return join(settings.app_dir, 'server', 'index.js')
end

local function start_server()
  if settings.app_dir == '' then
    log('No app folder set — open Tools > Scripts and point it at your obs-the-circle folder.')
    return
  end
  if not exists(server_entry()) then
    log('Cannot find ' .. server_entry() .. ' — check the app folder setting.')
    return
  end

  local node = settings.node_path
  if node == '' then node = find_node() end

  ensure_runtime_dir()
  write_heartbeat() -- so the watchdog sees a fresh beat before the server even starts

  local cmd
  if WINDOWS then
    -- wscript runs the shim with no console window. Without it, every OBS launch would
    -- leave a black cmd window sitting in the taskbar for the whole stream.
    local vbs = join(settings.app_dir, 'obs', 'launch-hidden.vbs')
    cmd = 'wscript ' .. quote(vbs) .. ' ' .. quote(node) .. ' ' .. quote(server_entry())
      .. ' --obs --port ' .. tostring(settings.port)
  else
    cmd = quote(node) .. ' ' .. quote(server_entry())
      .. ' --obs --port ' .. tostring(settings.port)
      .. ' >/dev/null 2>&1 &'
  end

  log('starting: ' .. cmd)
  os.execute(cmd)
  obs.timer_add(write_heartbeat, 10000)
end

local function stop_server()
  obs.timer_remove(write_heartbeat)

  local pid = read_pid()
  if not pid then
    log('no pidfile; nothing to stop')
    return
  end

  if WINDOWS then
    os.execute('taskkill /PID ' .. pid .. ' /F >nul 2>&1')
  else
    os.execute('kill ' .. pid .. ' >/dev/null 2>&1')
  end
  log('stopped server pid ' .. pid)

  -- Clearing the heartbeat means that if the kill somehow missed, the server's own
  -- watchdog still catches it within ~90s rather than running on.
  os.remove(beat_file())
end

---------------------------------------------------------------- OBS script hooks

function script_description()
  return [[
<h2>The Circle</h2>
<p>A battle-royale circle closing in on tonight's location. Starts with OBS, stops with OBS
&mdash; nothing runs when OBS is closed.</p>
<p><b>Set the app folder below</b>, then add these in OBS:</p>
<p><b>Sources &rarr; + &rarr; Browser</b> &middot; 1920&times;1080 &middot; untick
<i>Shutdown source when not visible</i><br>
<code>http://localhost:7333/overlay?layout=full</code></p>
<p><b>Docks &rarr; Custom Browser Docks&hellip;</b> &middot; name it <code>Circle</code><br>
<code>http://localhost:7333/control</code></p>
<p><a href="https://github.com/Obsidiate/obs-the-circle">Documentation</a></p>
]]
end

function script_defaults(s)
  obs.obs_data_set_default_string(s, 'app_dir', '')
  obs.obs_data_set_default_string(s, 'node_path', '')
  obs.obs_data_set_default_int(s, 'port', 7333)
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_path(
    props, 'app_dir', 'App folder', obs.OBS_PATH_DIRECTORY, nil, nil)
  obs.obs_properties_add_path(
    props, 'node_path', 'Node.js (blank = autodetect)', obs.OBS_PATH_FILE, nil, nil)
  obs.obs_properties_add_int(props, 'port', 'Port', 1024, 65535, 1)
  obs.obs_properties_add_button(props, 'restart', 'Restart The Circle', function()
    stop_server()
    start_server()
    return false
  end)
  return props
end

function script_update(s)
  local was_running = settings.app_dir ~= ''
  settings.app_dir = obs.obs_data_get_string(s, 'app_dir')
  settings.node_path = obs.obs_data_get_string(s, 'node_path')
  settings.port = obs.obs_data_get_int(s, 'port')
  -- Restart so a corrected folder or port takes effect without reloading the script.
  if was_running then stop_server() end
  start_server()
end

function script_load(s)
  settings.app_dir = obs.obs_data_get_string(s, 'app_dir')
  settings.node_path = obs.obs_data_get_string(s, 'node_path')
  settings.port = obs.obs_data_get_int(s, 'port')
  start_server()
end

function script_unload()
  stop_server()
end
