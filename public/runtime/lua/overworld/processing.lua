-- Project-owned terrain post-processing for generated cell data.

dofile("$SURVIVAL_DATA/Scripts/terrain/overworld/celldata.lua")
dofile("$SURVIVAL_DATA/Scripts/terrain/terrain_util.lua")
dofile("$SURVIVAL_DATA/Scripts/terrain/terrain_util2.lua")
dofile("$SURVIVAL_DATA/Scripts/terrain/overworld/excavation_island.lua")

local poiRotation = {
	[TYPE_MEADOW] = {
		{POI_CAMP,POI_RUIN,POI_RANDOM,POI_RUIN,POI_RANDOM,POI_RUIN},
		{POI_CAMP,POI_RUIN,POI_RANDOM,POI_RUIN_MEDIUM,POI_RANDOM_MEDIUM,POI_RUIN_MEDIUM}
	},
	[TYPE_FOREST] = {
		{POI_FOREST_CAMP,POI_FOREST_RUIN,POI_FOREST_RANDOM,POI_FOREST_CAMP,POI_FOREST_RANDOM},
		{POI_FOREST_CAMP,POI_FOREST_RUIN,POI_FOREST_RANDOM,POI_FOREST_RUIN_MEDIUM,POI_FOREST_RANDOM_MEDIUM}
	},
	[TYPE_DESERT] = {{POI_DESERT_RANDOM,POI_DESERT_OILPOOL},{POI_DESERT_RANDOM,POI_DESERT_OILPOOL}},
	[TYPE_FIELD] = {{POI_FARMINGPATCH,POI_FIELD_RUIN,POI_FIELD_RANDOM},{POI_FARMINGPATCH,POI_FIELD_RUIN,POI_FIELD_RANDOM}},
	[TYPE_BURNTFOREST] = {{POI_BURNTFOREST_CAMP,POI_BURNTFOREST_RUIN,POI_BURNTFOREST_RUIN},{POI_BURNTFOREST_CAMP,POI_BURNTFOREST_RUIN,POI_BURNTFOREST_RUIN}},
	[TYPE_AUTUMNFOREST] = {{POI_AUTUMNFOREST_CAMP,POI_AUTUMNFOREST_RUIN},{POI_AUTUMNFOREST_CAMP,POI_AUTUMNFOREST_RUIN}},
	[TYPE_LAKE] = {{POI_LAKE_RANDOM},{POI_LAKE_RANDOM,POI_LAKE_RUIN_MEDIUM,POI_LAKE_RANDOM_MEDIUM,POI_LAKE_RANDOM_MEDIUM}}
}

local twoCellPoi = {
	[POI_RUIN_MEDIUM]=true, [POI_RANDOM_MEDIUM]=true,
	[POI_FOREST_RUIN_MEDIUM]=true, [POI_FOREST_RANDOM_MEDIUM]=true,
	[POI_LAKE_RUIN_MEDIUM]=true, [POI_LAKE_RANDOM_MEDIUM]=true
}
local nextPoi = {}
for terrainType, _ in pairs(poiRotation) do nextPoi[terrainType] = {1,1} end

local function choosePoi(poi, requestedSize, terrainType)
	local choices = poiRotation[terrainType][requestedSize]
	assert(#choices > 0, "No POI choices for terrain " .. terrainType .. " and size " .. requestedSize)
	local cursor = nextPoi[terrainType][requestedSize]
	poi.type = choices[cursor]
	poi.size = twoCellPoi[poi.type] and 2 or 1
	poi.flat = terrainType == TYPE_LAKE
	nextPoi[terrainType][requestedSize] = cursor % #choices + 1
	return poi.type ~= nil
end

local function rewindPoi(requestedSize, terrainType)
	local choices = poiRotation[terrainType][requestedSize]
	local cursor = nextPoi[terrainType][requestedSize] - 1
	if cursor < 1 then cursor = #choices end
	nextPoi[terrainType][requestedSize] = cursor
end

function convertPlaceholderPois(pois)
	local converted = 0
	for _, poi in ipairs(pois) do
		if poi.type == POI_RANDOM_PLACEHOLDER then
			assert(poi.size == 2)
			if choosePoi(poi, 2, poi.terrainType) then
				if poi.size == 1 then
					poi.x = poi.x - (sm.noise.intNoise2d(poi.x,poi.y,g_cellData.seed+852) % 2)
					poi.y = poi.y - (sm.noise.intNoise2d(poi.x,poi.y,g_cellData.seed+299) % 2)
				end
				converted = converted + 1
			else
				print("Failed to select random poi type for placeholder at",poi.x,poi.y)
				print("Terrain type:",poi.terrainType)
				ddBox("mediumpoi",poi.x-1,poi.y-1,2,2,"ff0000")
			end
		end
	end
	print("Small/Medium random pois:",converted)
	removeFromArray(pois,function(poi) return poi.type == nil end)
end

function flattenPoiCliff(poi)
	local terrainType = math.floor(poi.type / 100)
	if terrainType == 0 then terrainType = TYPE_MEADOW end
	local margin = terrainType == TYPE_MEADOW and 0 or 1
	local half = math.floor(poi.size / 2)
	for dy = -margin, poi.size + margin do
		for dx = -margin, poi.size + margin do
			local x, y = poi.x + dx - half, poi.y + dy - half
			if insideCornerBounds(x,y) then
				g_cornerTemp.terrainType[y][x] = terrainType
				g_cellData.cliffLevel[y][x] = poi.cliffLevel or 0
				g_cornerTemp.forceFlat[y][x] = true
			end
		end
	end
end

function addBorderingMeadows()
	forEveryCell(function(x,y)
		local terrain = g_cornerTemp.terrainType
		if terrain[y][x] ~= TYPE_MEADOW and terrain[y][x+1] ~= TYPE_MEADOW and terrain[y][x] ~= terrain[y][x+1] then terrain[y][x+1]=TYPE_MEADOW end
		if terrain[y][x] ~= TYPE_MEADOW and terrain[y+1][x] ~= TYPE_MEADOW and terrain[y][x] ~= terrain[y+1][x] then terrain[y+1][x]=TYPE_MEADOW end
		if terrain[y][x] ~= TYPE_MEADOW and terrain[y+1][x+1] ~= TYPE_MEADOW and terrain[y][x] ~= terrain[y+1][x+1] then terrain[y+1][x+1]=TYPE_MEADOW end
		if terrain[y+1][x] ~= TYPE_MEADOW and terrain[y][x+1] ~= TYPE_MEADOW and terrain[y+1][x] ~= terrain[y][x+1] then
			if terrain[y+1][x] == TYPE_LAKE then terrain[y+1][x]=TYPE_MEADOW else terrain[y][x+1]=TYPE_MEADOW end
		end
	end)
end

local neighborRing = {{-1,-1},{0,-1},{1,-1},{1,0},{1,1},{0,1},{-1,1},{-1,0}}

local function clampCornerSlope(x,y,lower)
	local corrections, violations = 0,0
	local extreme = lower and math.huge or -math.huge
	for _, offset in ipairs(neighborRing) do
		local value = getCornerCliffLevel(x+offset[1],y+offset[2])
		extreme = lower and math.min(extreme,value) or math.max(extreme,value)
	end
	local current = g_cellData.cliffLevel[y][x]
	local invalid = lower and extreme < current-3 or (not lower and extreme > current+3)
	if invalid then
		if g_cornerTemp.forceFlat[y][x] then violations=1
		else g_cellData.cliffLevel[y][x] = lower and extreme+3 or extreme-3; corrections=1 end
	end
	return corrections,violations
end

local function clampRoadCell(x,y,lower,roadNodes)
	local node = roadNodes[y][x]
	local roadCount = 0
	if node then for _, edge in ipairs(node.edges) do if edge.road then roadCount=roadCount+1 end end end
	if roadCount == 0 then return 0,0 end

	local points = {{x,y},{x+1,y},{x+1,y+1},{x,y+1}}
	local low, high = math.huge,-math.huge
	for _, point in ipairs(points) do
		local value=g_cellData.cliffLevel[point[2]][point[1]]
		low,high=math.min(low,value),math.max(high,value)
	end
	local allowed = roadCount == 2 and 1 or 0
	if high-low <= allowed then return 0,0 end

	local limit = lower and low+allowed or high-allowed
	local corrections,violations=0,0
	for _, point in ipairs(points) do
		local px,py=point[1],point[2]
		local value=g_cellData.cliffLevel[py][px]
		local invalid=lower and value>limit or (not lower and value<limit)
		if invalid then
			if g_cornerTemp.forceFlat[py][px] then violations=violations+1
			else g_cellData.cliffLevel[py][px]=limit; corrections=corrections+1 end
		end
	end
	return corrections,violations
end

local function sweep(clamp,roadNodes,lower,reverse)
	local minX=g_cellData.bounds.xMin+g_cellData.padding
	local maxX=g_cellData.bounds.xMax-g_cellData.padding
	local minY=g_cellData.bounds.yMin+g_cellData.padding
	local maxY=g_cellData.bounds.yMax-g_cellData.padding
	local corrections,violations=0,0
	local yStart,yEnd,yStep=minY,maxY,1
	local xStart,xEnd,xStep=minX,maxX,1
	if reverse then yStart,yEnd,yStep=maxY,minY,-1; xStart,xEnd,xStep=maxX,minX,-1 end
	for y=yStart,yEnd,yStep do for x=xStart,xEnd,xStep do
		local c,v=clamp(x,y,lower,roadNodes)
		corrections,violations=corrections+c,violations+v
	end end
	return corrections,violations
end

function enforceCliffRoadLimitations(roadNodes)
	local pass,hasViolations=1,true
	while pass<=5 and hasViolations do
		hasViolations=false
		local lower=pass%2==1
		local _,v1=sweep(clampCornerSlope,roadNodes,lower,false); hasViolations=hasViolations or v1>0
		local _,v2=sweep(clampCornerSlope,roadNodes,lower,true); hasViolations=hasViolations or v2>0
		local c3,v3=sweep(clampRoadCell,roadNodes,lower,false); hasViolations=hasViolations or v3>0
		print("Road SW to NE:",c3,"corrections,",v3,"violations")
		local c4,v4=sweep(clampRoadCell,roadNodes,lower,true); hasViolations=hasViolations or v4>0
		print("Road NE to SW:",c4,"corrections,",v4,"violations")
		pass=pass+1
	end
end

function evaluateRoadsAndCliffs(roadNodes)
	local minX=g_cellData.bounds.xMin+g_cellData.padding
	local maxX=g_cellData.bounds.xMax-g_cellData.padding
	local minY=g_cellData.bounds.yMin+g_cellData.padding
	local maxY=g_cellData.bounds.yMax-g_cellData.padding
	for y=minY,maxY do for x=minX,maxX do
		local cliffBits=calculateCliffBits(getCornerCliffLevel(x+1,y),getCornerCliffLevel(x,y),getCornerCliffLevel(x,y+1),getCornerCliffLevel(x+1,y+1))
		local east,north,west,south=false,false,false,false
		local node=roadNodes[y][x]
		if node then for _, edge in ipairs(node.edges) do if edge.road then
			if edge.n.y==node.y then east=east or edge.n.x>node.x; west=west or edge.n.x<node.x
			elseif edge.n.x==node.x then north=north or edge.n.y>node.y; south=south or edge.n.y<node.y end
		end end end
		g_cellData.flags[y][x]=bit.bor(g_cellData.flags[y][x],bit.bor(calculateRoadBits(south,west,north,east),cliffBits))
	end end
	for y=minY,maxY do for x=minX,maxX do
		local flags=getRoadCliffFlags(x,y)
		local tileId,rotation=getCliffRoadTileIdAndRotation(flags,sm.noise.intNoise2d(x,y,g_cellData.seed+2854))
		if not tileId:isNil() and g_cellData.uid[y][x]:isNil() then
			g_cellData.uid[y][x]=tileId; g_cellData.xOffset[y][x]=0; g_cellData.yOffset[y][x]=0
			g_cellData.rotation[y][x]=rotation; g_cellData.groupId[y][x]=0
		end
	end end
end

local function aroundPoi(poi,callback)
	local half=math.floor(poi.size/2)
	for dy=-1,poi.size+1 do
		local edgeRow=dy==-1 or dy==poi.size+1
		for dx=(edgeRow and 0 or -1),poi.size+(edgeRow and 0 or 1) do
			local x,y=poi.x+dx-half,poi.y+dy-half
			if insideCornerBounds(x,y) then callback(x,y) end
		end
	end
end

function setForcedAndLakeAdjacentPoiHillynessToZero(poi)
	if not poi.flat then return end
	local touchesLake=false
	if not poi.forceFlat then aroundPoi(poi,function(x,y) if g_cornerTemp.lakeAdjacent[y][x] then touchesLake=true end end) end
	if touchesLake or poi.forceFlat then aroundPoi(poi,function(x,y) g_cornerTemp.hillyness[y][x]=0 end) end
end

function smoothPoiElevation(poi)
	if not poi.elevationSmoothing then return end
	local half=math.floor(poi.size/2)
	local total,count=0,0
	for dy=0,poi.size do for dx=0,poi.size do
		local x,y=poi.x+dx-half,poi.y+dy-half
		if insideCornerBounds(x,y) then total=total+g_cellData.elevation[y][x]; count=count+1 end
	end end
	if count==0 then return end
	local average,rings=total/count,poi.elevationSmoothing
	for dy=-rings,poi.size+rings do for dx=-rings,poi.size+rings do
		local ox=dx<0 and -dx or (dx>poi.size and dx-poi.size or 0)
		local oy=dy<0 and -dy or (dy>poi.size and dy-poi.size or 0)
		local ring=math.max(ox,oy)
		if ring>0 and ring<=rings then
			local x,y=poi.x+dx-half,poi.y+dy-half
			if insideCornerBounds(x,y) then
				local blend=(rings-ring+1)/(rings+1)
				local value=g_cellData.elevation[y][x]
				g_cellData.elevation[y][x]=value+(average-value)*blend
			end
		end
	end end
end

function flattenPoiElevation(poi)
	if not poi.flat then return end
	local total,count,lake=0,0,false
	aroundPoi(poi,function(x,y)
		total=total+g_cellData.elevation[y][x]; count=count+1
		lake=lake or g_cornerTemp.lakeAdjacent[y][x] or poi.type==POI_TEST
	end)
	local average=lake and 0 or round(4*total/count)/4
	aroundPoi(poi,function(x,y) g_cellData.elevation[y][x]=average end)
	local half=math.floor(poi.size/2)
	for dy=0,poi.size do for dx=0,poi.size do
		local x,y=poi.x+dx-half,poi.y+dy-half
		if insideCellBounds(x,y) then g_cellData.flags[y][x]=bit.bor(g_cellData.flags[y][x],MASK_FLAT) end
	end end
end

local function uniformSquare(x,y,size,terrainType)
	for dy=0,size do for dx=0,size do
		if g_cornerTemp.terrainType[y+dy][x+dx]~=terrainType then return false end
	end end
	return true
end

local function placeTerrainCompatible(poi)
	local x0=poi.x-math.floor(poi.size/2)
	local y0=poi.y-math.floor(poi.size/2)
	local terrainType=math.floor(poi.type/100)
	if uniformSquare(x0,y0,poi.size,terrainType) then return true end
	for y=y0-1,y0+poi.size do for x=x0-1,x0+poi.size do
		if bit.band(g_cellData.flags[y][x],MASK_ROADS)~=0 then
			if g_cornerTemp.terrainType[y][x]~=terrainType or g_cornerTemp.terrainType[y][x+1]~=terrainType or g_cornerTemp.terrainType[y+1][x]~=terrainType or g_cornerTemp.terrainType[y+1][x+1]~=terrainType then return false end
		end
	end end
	for y=y0,y0+poi.size do for x=x0,x0+poi.size do g_cornerTemp.terrainType[y][x]=terrainType end end
	return true
end

function addExtraPois(pois,padding)
	local mediumSpots,smallSpots={},{}
	for gridY=0,30 do for gridX=0,40 do
		local y=gridY*3-46
		local x=gridX*3-62+(gridY%3)
		local terrainType=g_cornerTemp.terrainType[y][x]
		local fits=uniformSquare(x,y,2,terrainType) and g_cellData.flags[y][x]==0 and g_cellData.flags[y][x+1]==0 and g_cellData.flags[y+1][x]==0 and g_cellData.flags[y+1][x+1]==0
		if fits and not collides(x+1,y+1,4,pois) then
			mediumSpots[#mediumSpots+1]={x=x+1,y=y+1,terrainType=terrainType}
		else
			local offsets={{x=0,y=0},{x=1,y=0},{x=0,y=1},{x=1,y=1}}
			shuffle(offsets)
			for _,offset in ipairs(offsets) do
				y=gridY*3-46+offset.y; x=gridX*3-62+(gridY%3)+offset.x
				terrainType=g_cornerTemp.terrainType[y][x]
				fits=uniformSquare(x,y,1,terrainType) and g_cellData.flags[y][x]==0
				if fits and not collides(x,y,3,pois) then
					smallSpots[#smallSpots+1]={x=x,y=y,terrainType=terrainType}; break
				end
			end
		end
	end end
	print("Medium extra poi spots:",#mediumSpots); print("Small extra poi spots:",#smallSpots)

	local mediumCount,smallCount=0,0
	local function fill(spots,requestedSize)
		shuffle(spots)
		for _,spot in ipairs(spots) do
			local poi={x=spot.x,y=spot.y,type=nil,size=nil,road=false,flat=false,terrainType=spot.terrainType,edges={}}
			if choosePoi(poi,requestedSize,spot.terrainType) then
				if placeTerrainCompatible(poi) then
					writePoi(poi,padding)
					if poi.size==2 then mediumCount=mediumCount+1 else smallCount=smallCount+1 end
				else rewindPoi(requestedSize,spot.terrainType) end
			end
		end
	end
	fill(mediumSpots,2); fill(smallSpots,1)
	print("Medium extra pois:",mediumCount); print("Small extra pois:",smallCount)
end

function evaluateType(terrainType,selector)
	forEveryCell(function(x,y)
		if not g_cellData.uid[y][x]:isNil() then return end
		local corners=g_cornerTemp.terrainType
		local bits=bit.bor(
			bit.tobit(corners[y][x+1]==terrainType and 8 or 0),
			bit.tobit(corners[y][x]==terrainType and 4 or 0),
			bit.tobit(corners[y+1][x]==terrainType and 2 or 0),
			bit.tobit(corners[y+1][x+1]==terrainType and 1 or 0)
		)
		local tileId,rotation=selector(bits,sm.noise.intNoise2d(x,y,g_cellData.seed+2854),sm.noise.intNoise2d(x,y,g_cellData.seed+9439))
		if not tileId:isNil() then
			g_cellData.uid[y][x]=tileId; g_cellData.rotation[y][x]=rotation
			g_cellData.xOffset[y][x]=0; g_cellData.yOffset[y][x]=0
			g_cellData.flags[y][x]=bit.bor(g_cellData.flags[y][x],bit.band(bit.lshift(terrainType,SHIFT_TERRAINTYPE),MASK_TERRAINTYPE))
		end
	end)
end
