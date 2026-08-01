--[[
  Exercises obs/the-circle.lua against a stubbed obslua.

  This cannot test OBS itself — whether script_unload really fires on exit is something
  only a machine with OBS can answer. What it does test is everything underneath: that the
  script locates node, spawns a real server that answers on its port, keeps a heartbeat,
  and kills the process on unload leaving nothing behind.

  Run: luajit test/obs-lua.test.lua
]]

local fails = 0
local function ok(cond, msg)
  if not cond then
    print('FAIL: ' .. msg)
    fails = fails + 1
  else
    print('  ok  ' .. msg)
  end
end

local function sh(cmd)
  local p = io.popen(cmd .. ' 2>&1')
  local out = p:read('*a')
  p:close()
  return (out:gsub('%s+$', ''))
end

local APP = sh('pwd')
local PORT = 7555

------------------------------------------------------------------ obslua stub

local timers = {}
obslua = {
  OBS_PATH_DIRECTORY = 1,
  OBS_PATH_FILE = 2,
  timer_add = function(fn, interval) timers[fn] = interval end,
  timer_remove = function(fn) timers[fn] = nil end,
  obs_data_set_default_string = function() end,
  obs_data_set_default_int = function() end,
  obs_properties_create = function() return {} end,
  obs_properties_add_path = function() end,
  obs_properties_add_int = function() end,
  obs_properties_add_button = function() end,
  obs_data_get_string = function(t, k) return t[k] or '' end,
  obs_data_get_int = function(t, k) return t[k] or 0 end,
}

dofile(APP .. '/obs/the-circle.lua')

------------------------------------------------------------------------ tests

print('\n== description and properties ==')
local desc = script_description()
ok(desc:find('The Circle'), 'description mentions the project')
ok(desc:find('7333'), 'description carries the default URLs')
ok(pcall(script_properties), 'script_properties builds without error')

print('\n== start ==')
local settings = { app_dir = APP, node_path = '', port = PORT }
script_load(settings)

-- Give node a moment to bind.
os.execute('sleep 3')

local pidfile = APP .. '/.runtime/server.pid'
local f = io.open(pidfile, 'r')
ok(f ~= nil, 'pidfile written')
local pid = f and f:read('*a'):gsub('%s', '') or ''
if f then f:close() end
ok(pid ~= '', 'pidfile contains a pid (' .. pid .. ')')

local code = sh('curl -s -o /dev/null -w "%{http_code}" http://localhost:' .. PORT .. '/api/state')
ok(code == '200', 'server answers on port ' .. PORT .. ' (got ' .. code .. ')')

local alive = sh('ps -p ' .. pid .. ' -o comm= 2>/dev/null')
ok(alive ~= '', 'process ' .. pid .. ' is running (' .. alive .. ')')

print('\n== heartbeat ==')
local beatfile = APP .. '/.runtime/obs.heartbeat'
local b = io.open(beatfile, 'r')
ok(b ~= nil, 'heartbeat file written on start')
local first = b and b:read('*a') or ''
if b then b:close() end
ok(tonumber(first) ~= nil and tonumber(first) > 0, 'heartbeat holds an epoch-ms timestamp')

local registered = false
for fn, interval in pairs(timers) do
  if interval == 10000 then registered = true end
end
ok(registered, 'heartbeat timer registered at 10s')

print('\n== stop ==')
script_unload()
os.execute('sleep 2')

local still = sh('ps -p ' .. pid .. ' -o comm= 2>/dev/null')
ok(still == '', 'process killed on script_unload')

local code2 = sh('curl -s -o /dev/null -m 2 -w "%{http_code}" http://localhost:' .. PORT .. '/api/state')
ok(code2 ~= '200', 'port no longer answers (got ' .. code2 .. ')')

ok(io.open(beatfile, 'r') == nil, 'heartbeat cleared, so a missed kill still self-terminates')

local n = 0
for _ in pairs(timers) do n = n + 1 end
ok(n == 0, 'heartbeat timer removed')

print('')
if fails == 0 then
  print('ALL OBS LUA TESTS PASSED')
else
  print(fails .. ' FAILURES')
  os.exit(1)
end
