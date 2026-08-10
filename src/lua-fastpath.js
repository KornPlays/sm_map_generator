// Bit twiddling, integer noise, and the LuaJIT PRNG used to be JavaScript
// callbacks installed on the Lua engine. Generating one world calls them about
// 700,000 times, and every single call crossed the WebAssembly bridge: wasmoon
// reads each argument off the Lua stack through `ccall`, invokes the closure,
// allocates a BigInt for the integer result, and pushes it back. That marshalling
// cost far more than the arithmetic itself.
//
// Lua 5.4 has native 64-bit integers and bitwise operators, so the identical
// arithmetic now runs inside the VM with no bridge traffic. Only simplexNoise2d
// stays in JavaScript: it needs float32 rounding on every intermediate value,
// which Lua can only reach through string.pack and would be slower than the
// bridge it avoids.
//
// Everything here reproduces the previous JavaScript semantics exactly, because
// the generated world layout must stay bit-for-bit identical.
export const FAST_PATH_PRELUDE = `
local mtointeger = math.tointeger
local mfloor = math.floor
local mceil = math.ceil
local mult = math.ult
local spack = string.pack
local sunpack = string.unpack

------------------------------------------------------------------------------
-- LuaJIT bit library
------------------------------------------------------------------------------

-- JavaScript's \`value | 0\`: coerce to a number, truncate toward zero, wrap to
-- 32 bits, then read the result as signed. The string branch matters because
-- biome_roads.lua feeds bit.lshift the digit captures from a pattern match.
local function toi32(value)
    local integral = mtointeger(value)
    if integral == nil then
        local number = tonumber(value) or 0
        integral = mtointeger(number >= 0 and mfloor(number) or mceil(number)) or 0
    end
    integral = integral & 0xFFFFFFFF
    if integral >= 0x80000000 then return integral - 0x100000000 end
    return integral
end

-- Sign-extended 32-bit operands keep their low 32 bits through and/or/not, so
-- only the shifts have to be re-normalised afterwards.
local function norm32(value)
    value = value & 0xFFFFFFFF
    if value >= 0x80000000 then return value - 0x100000000 end
    return value
end

function _sm_tobit(value)
    return toi32(value)
end

-- The world generator calls these with two to five operands. Folding the extra
-- operands in with nil checks avoids the vararg allocation on the hot two-operand
-- path, which runs about 190,000 times per world.
function _sm_band(a, b, c, d, e)
    local value = toi32(a)
    if b ~= nil then value = value & toi32(b) end
    if c ~= nil then value = value & toi32(c) end
    if d ~= nil then value = value & toi32(d) end
    if e ~= nil then value = value & toi32(e) end
    return value
end

function _sm_bor(a, b, c, d, e)
    local value = toi32(a)
    if b ~= nil then value = value | toi32(b) end
    if c ~= nil then value = value | toi32(c) end
    if d ~= nil then value = value | toi32(d) end
    if e ~= nil then value = value | toi32(e) end
    return value
end

function _sm_bnot(value)
    return ~toi32(value)
end

function _sm_lshift(value, shift)
    return norm32(toi32(value) << (shift & 31))
end

function _sm_rshift(value, shift)
    return norm32((toi32(value) & 0xFFFFFFFF) >> (shift & 31))
end

------------------------------------------------------------------------------
-- sm.noise.intNoise2d
------------------------------------------------------------------------------

-- Lua's >> is a logical shift, so the sign-propagating shift the original
-- performs on an int32 is rebuilt from a floored division. Replacing the divide
-- with a shift plus a sign fill, and inlining it at each site, both measured as
-- no change against this workload, so the readable form is kept.
local function asr32(value, count)
    if value < 0x80000000 then return value >> count end
    return ((value - 0x100000000) // (1 << count)) & 0xFFFFFFFF
end

-- Intermediates stay in unsigned 32-bit space; the multiplications are the
-- 32-bit wrapping ones the original reaches through Math.imul.
local function mix32(value)
    value = ((value << 15) + ~value) & 0xFFFFFFFF
    value = value ~ asr32(value, 12)
    value = (value * 5) & 0xFFFFFFFF
    value = value ~ asr32(value, 4)
    return (value * 0x809) & 0xFFFFFFFF
end

local function tou32(value)
    local integral = mtointeger(value)
    if integral == nil then
        local number = tonumber(value) or 0
        integral = mtointeger(number >= 0 and mfloor(number) or mceil(number)) or 0
    end
    return integral & 0xFFFFFFFF
end

-- Mirrors the intNoise2d implementation embedded in ScrapMechanic.exe.
function _sm_int_noise(rawX, rawY, rawSeed)
    local value = mix32(tou32(rawY))
    value = mix32(((value ~ asr32(value, 16)) + tou32(rawX)) & 0xFFFFFFFF)
    value = mix32(((value ~ asr32(value, 16)) + tou32(rawSeed)) & 0xFFFFFFFF)
    return norm32(value ~ asr32(value, 16))
end

------------------------------------------------------------------------------
-- math.random / math.randomseed
------------------------------------------------------------------------------

-- LuaJIT's period-2^223 Tausworthe generator. Lua 5.4's integers are exactly the
-- 64-bit words this needs, and its >> is the unsigned shift the algorithm wants.
local RNG_MASK1 = ~0 << 1
local RNG_MASK2 = ~0 << 6
local RNG_MASK3 = ~0 << 9
local RNG_MASK4 = ~0 << 17
local DOUBLE_MANTISSA = 0x000fffffffffffff
local DOUBLE_ONE = 0x3ff0000000000000
-- Math.PI and Math.E as Lua parses them to the same doubles.
local SEED_PI = 3.141592653589793
local SEED_E = 2.718281828459045

local rng1, rng2, rng3, rng4 = 0, 0, 0, 0

local function rngStep()
    local v1 = (((rng1 << 31) ~ rng1) >> 45) ~ ((rng1 & RNG_MASK1) << 18)
    local v2 = (((rng2 << 19) ~ rng2) >> 30) ~ ((rng2 & RNG_MASK2) << 28)
    local v3 = (((rng3 << 24) ~ rng3) >> 48) ~ ((rng3 & RNG_MASK3) << 7)
    local v4 = (((rng4 << 21) ~ rng4) >> 39) ~ ((rng4 & RNG_MASK4) << 8)
    rng1, rng2, rng3, rng4 = v1, v2, v3, v4
    return v1 ~ v2 ~ v3 ~ v4
end

-- Reproduces LuaJIT's bit-pattern conversion: the seed is churned through a
-- double and the raw mantissa bits become the state word.
local function rngRandom()
    local bits = (rngStep() & DOUBLE_MANTISSA) | DOUBLE_ONE
    return (sunpack("<d", spack("<i8", bits))) - 1
end

function _sm_randomseed(initialValue)
    local value = (tonumber(initialValue) or 0) + 0.0
    local shifts = 0x11090601
    local seeded = {}
    for index = 1, 4 do
        local minimum = 1 << (shifts & 255)
        shifts = shifts >> 8
        value = value * SEED_PI + SEED_E
        local bits = sunpack("<i8", spack("<d", value))
        if mult(bits, minimum) then bits = bits + minimum end
        seeded[index] = bits
    end
    rng1, rng2, rng3, rng4 = seeded[1], seeded[2], seeded[3], seeded[4]
    for _ = 1, 10 do rngStep() end
end

function _sm_random(lower, upper)
    local result
    if lower == nil then result = rngRandom()
    elseif upper == nil then result = mfloor(rngRandom() * lower) + 1
    else result = mfloor(rngRandom() * (upper - lower + 1)) + lower end
    return result
end
`;
