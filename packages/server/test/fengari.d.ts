// The slice of fengari (a pure-JS Lua VM, which ships no types) that the
// registry gate's Lua test drives.
declare module 'fengari' {
  type LuaState = { readonly __luaState: unique symbol }
  const fengari: {
    lua: {
      LUA_OK: number
      lua_getglobal: (L: LuaState, name: Uint8Array) => number
      lua_setglobal: (L: LuaState, name: Uint8Array) => void
      lua_pushstring: (L: LuaState, s: Uint8Array) => void
      lua_pushnil: (L: LuaState) => void
      lua_pushboolean: (L: LuaState, b: boolean) => void
      lua_pushjsfunction: (L: LuaState, fn: (L: LuaState) => number) => void
      lua_pcall: (L: LuaState, nargs: number, nresults: number, msgh: number) => number
      lua_pop: (L: LuaState, n: number) => void
      lua_tostring: (L: LuaState, idx: number) => Uint8Array
      lua_tojsstring: (L: LuaState, idx: number) => string
    }
    lauxlib: {
      luaL_newstate: () => LuaState
      luaL_loadstring: (L: LuaState, s: Uint8Array) => number
      luaL_error: (L: LuaState, msg: Uint8Array) => number
    }
    lualib: { luaL_openlibs: (L: LuaState) => void }
    to_luastring: (s: string) => Uint8Array
  }
  export default fengari
}
