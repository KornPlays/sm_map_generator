-- Project-owned road-network implementation for the browser generator.

local terrainTravelCost = {
	[TYPE_MEADOW] = 3, [TYPE_FOREST] = 3, [TYPE_FIELD] = 3,
	[TYPE_BURNTFOREST] = 3, [TYPE_AUTUMNFOREST] = 3,
	[TYPE_LAKE] = 3, [TYPE_DESERT] = 3
}

local roadDecorationCycle = {
	POI_ROAD_CHEMPOOL, POI_ROAD_SCHEMATICSTATION,
	POI_ROAD_KIOSK, POI_ROAD_KIOSK
}
local nextRoadDecoration = 1

local function manhattan(a, b)
	return math.abs(a.x - b.x) + math.abs(a.y - b.y)
end

local function visiblePair(points, aIndex, bIndex)
	local a, b = points[aIndex], points[bIndex]
	local midX, midY = (a.x + b.x) / 2, (a.y + b.y) / 2
	local radius2 = dist2(a.x, a.y, midX, midY)
	for index, point in ipairs(points) do
		if index ~= aIndex and index ~= bIndex and dist2(point.x, point.y, midX, midY) < radius2 then
			return false
		end
	end
	return true
end

function preparePoiRoadGraph(pois, roadPois)
	for _, poi in ipairs(pois) do
		if poi.road then
			roadPois[#roadPois + 1] = poi
			poi.edges = {}
		end
	end

	for left = 1, #roadPois - 1 do
		for right = left + 1, #roadPois do
			if visiblePair(roadPois, left, right) then
				local a, b = roadPois[left], roadPois[right]
				local levelDelta = math.abs((a.cliffLevel or 0) - (b.cliffLevel or 0))
				local cost = manhattan(a, b) + levelDelta ^ 2 * 10
				a.edges[#a.edges + 1] = { n = b, cost = cost }
				b.edges[#b.edges + 1] = { n = a, cost = cost }
			end
		end
	end
end

function hasRoad(cellX, cellY, nodes)
	local row = nodes[cellY]
	local node = row and row[cellX]
	if not node then return false end
	for _, edge in ipairs(node.edges) do
		if edge.road then return true end
	end
	return false
end

function writeDistancesInNodes(target, source)
	source.dist = 0
	local queue, visited = { source }, {}
	local targetDistance, iterations = math.huge, 0

	while #queue > 0 do
		local pick, pickIndex
		for index, candidate in ipairs(queue) do
			if not pick or candidate.dist < pick.dist then
				pick, pickIndex = candidate, index
			end
		end
		queue[pickIndex] = queue[#queue]
		queue[#queue] = nil
		visited[pick] = true

		for _, edge in ipairs(pick.edges) do
			if not visited[edge.n] then
				local proposed = pick.dist + edge.cost
				if proposed < edge.n.dist then
					edge.n.dist = proposed
					if edge.n == target and proposed < targetDistance then targetDistance = proposed end
					if proposed <= targetDistance then queue[#queue + 1] = edge.n end
				end
			end
		end
		iterations = iterations + 1
	end
	return targetDistance, iterations
end

local function cheaperPathStep(node)
	local chosen
	for _, edge in ipairs(node.edges) do
		if not chosen or edge.n.dist < chosen.n.dist then chosen = edge end
	end
	return chosen
end

function findRoadPath(roadPois, roadEdges, start, destination)
	for _, poi in ipairs(roadPois) do poi.dist = math.huge end
	writeDistancesInNodes(start, destination)
	local node = start
	while node ~= destination do
		local edge = cheaperPathStep(node)
		if not edge then sm.log.error("No path found!"); break end
		local following = edge.n
		roadEdges[#roadEdges + 1] = { a = node, b = following }
		local levelDelta = math.abs((node.cliffLevel or 0) - (following.cliffLevel or 0))
		local revisedCost = manhattan(node, following) + levelDelta ^ 2 * 10
		edge.cost = revisedCost
		for _, reverse in ipairs(following.edges) do
			if reverse.n == node then reverse.cost = revisedCost end
		end
		node = following
	end
end

local function includes(value, values)
	return isAnyOf(value, values)
end

function drawRoads(roadEdges, pois)
	local nodes = {}
	local minX = g_cellData.bounds.xMin + g_cellData.padding
	local maxX = g_cellData.bounds.xMax - g_cellData.padding
	local minY = g_cellData.bounds.yMin + g_cellData.padding
	local maxY = g_cellData.bounds.yMax - g_cellData.padding

	local function addNode(x, y)
		assert(nodes[y][x] == nil, "Node already exists " .. x .. ", " .. y)
		nodes[y][x] = { x = x, y = y, edges = {} }
	end

	for y = minY, maxY do
		nodes[y] = {}
		for x = minX, maxX do
			if not collides(x, y, 1, pois) then
				local nearby = collides(x, y, 3, pois)
				local typeAtPoint = nearby and (nearby.type == POI_RANDOM_PLACEHOLDER and nearby.terrainType or math.floor(nearby.type / 100))
				if not nearby or typeAtPoint == TYPE_MEADOW then addNode(x, y) end
			end
		end
	end

	local function jitter(x, y)
		local seed = g_cellData.seed % 32768
		return math.abs(sm.noise.simplexNoise2d(
			(x + 256 * (seed + 53)) / 3.7,
			(y + 256 * (seed + 96)) / 3.7
		)) * 50
	end

	local function join(a, b, cost, road)
		if not a or not b then return end
		for _, edge in ipairs(a.edges) do assert(edge.n ~= b) end
		for _, edge in ipairs(b.edges) do assert(edge.n ~= a) end
		a.edges[#a.edges + 1] = { n = b, cost = cost, road = road }
		b.edges[#b.edges + 1] = { n = a, cost = cost, road = road }
	end

	local function joinEast(x, y, road)
		local a, b = nodes[y][x], nodes[y][x + 1]
		if not a or not b then return end
		local base = math.max(terrainTravelCost[g_cornerTemp.terrainType[y][x + 1]], terrainTravelCost[g_cornerTemp.terrainType[y + 1][x + 1]])
		local c = g_cellData.cliffLevel
		local hi = math.max(c[y][x], c[y + 1][x], c[y][x + 1], c[y + 1][x + 1], c[y][x + 2], c[y + 1][x + 2])
		local lo = math.min(c[y][x], c[y + 1][x], c[y][x + 1], c[y + 1][x + 1], c[y][x + 2], c[y + 1][x + 2])
		join(a, b, base + (hi - lo) ^ 2 * 5 + jitter(x + 0.5, y), road)
	end

	local function joinNorth(x, y, road)
		local a, b = nodes[y][x], nodes[y + 1][x]
		if not a or not b then return end
		local base = math.max(terrainTravelCost[g_cornerTemp.terrainType[y + 1][x]], terrainTravelCost[g_cornerTemp.terrainType[y + 1][x + 1]])
		local c = g_cellData.cliffLevel
		local hi = math.max(c[y][x], c[y][x + 1], c[y + 1][x], c[y + 1][x + 1], c[y + 2][x], c[y + 2][x + 1])
		local lo = math.min(c[y][x], c[y][x + 1], c[y + 1][x], c[y + 1][x + 1], c[y + 2][x], c[y + 2][x + 1])
		join(a, b, base + (hi - lo) ^ 2 * 5 + jitter(x, y + 0.5), road)
	end

	for y = minY, maxY do for x = minX, maxX - 1 do joinEast(x, y) end end
	for y = minY, maxY - 1 do for x = minX, maxX do joinNorth(x, y) end end

	local function addOffsetNodes(poi, offsets)
		for _, offset in ipairs(offsets) do addNode(poi.x + offset[1], poi.y + offset[2]) end
	end
	local function addOffsetEdges(poi, offsets, north, road)
		for _, offset in ipairs(offsets) do
			if north then joinNorth(poi.x + offset[1], poi.y + offset[2], road)
			else joinEast(poi.x + offset[1], poi.y + offset[2], road) end
		end
	end
	local function shortcut(x0, y0, x1, y1)
		local a, b = nodes[y0][x0], nodes[y1][x1]
		if a and b then
			a.edges[#a.edges + 1] = { n = b, cost = 1, shortcut = true }
			b.edges[#b.edges + 1] = { n = a, cost = 1, shortcut = true }
		end
	end

	local randomRoadPoiCount = 0
	local function configureRandomRoadPoi(poi, dx, dy)
		if poi.type ~= POI_RANDOM_PLACEHOLDER or not poi.road then return end
		poi.type = roadDecorationCycle[nextRoadDecoration]
		nextRoadDecoration = nextRoadDecoration % #roadDecorationCycle + 1
		poi.rotation = (math.abs(dy) > math.abs(dx) and 1 or 0) + (sm.noise.intNoise2d(poi.x, poi.y, g_cellData.seed + 211) % 2) * 2
		poi.size, poi.flat = 1, false

		addOffsetNodes(poi, {{-1,0},{-1,-1},{0,-1}})
		addOffsetEdges(poi, {{-2,-1},{-2,0},{-1,-1},{0,-1}}, false)
		addOffsetEdges(poi, {{-1,-2},{0,-2},{-1,-1},{-1,0}}, true)
		if poi.terrainType ~= TYPE_MEADOW then
			addOffsetNodes(poi, {{-2,-2},{-1,-2},{0,-2},{1,-2},{-2,1},{-1,1},{0,1},{1,1},{-2,-1},{-2,0},{1,-1},{1,0}})
			addOffsetEdges(poi, {{-3,-2},{-3,-1},{-3,0},{-3,1},{-2,-2},{-2,-1},{-2,0},{-2,1},{-1,-2},{-1,1},{0,-2},{0,-1},{0,1},{1,-2},{1,-1},{1,0},{1,1}}, false)
			addOffsetEdges(poi, {{-2,-3},{-1,-3},{0,-3},{1,-3},{-2,-2},{-1,-2},{0,-2},{1,-2},{-2,-1},{1,-1},{-2,0},{-1,0},{1,0},{-2,1},{-1,1},{0,1},{1,1}}, true)
		end
		randomRoadPoiCount = randomRoadPoiCount + 1
	end

	local mediumTypes = { POI_MECHANICSTATION_MEDIUM, POI_MECHANICSTATION_QUEST_MEDIUM, POI_PACKINGSTATIONVEG_MEDIUM, POI_PACKINGSTATIONFRUIT_MEDIUM }
	local warehouseTypes = { POI_WAREHOUSE2_LARGE, POI_WAREHOUSE3_LARGE, POI_WAREHOUSE4_LARGE, POI_WAREHOUSE4_QUEST_LARGE }
	local inlineTypes = { POI_ROAD_KIOSK, POI_BUILDERQUEST_RESOURCECAR, POI_ROAD_SCHEMATICSTATION, POI_ROAD_CHEMPOOL, POI_ROAD_RANDOM }

	local function connectionPoint(poi, other)
		local dx, dy = poi.x - other.x, poi.y - other.y
		configureRandomRoadPoi(poi, dx, dy)
		if poi.rotation == nil and poi.type == POI_BUILDERQUEST_RESOURCECAR then
			poi.rotation = (math.abs(dy) > math.abs(dx) and 1 or 0) + (sm.noise.intNoise2d(poi.x, poi.y, g_cellData.seed + 211) % 2) * 2
		end
		if poi.rotation == nil and includes(poi.type, mediumTypes) then
			poi.rotation = math.abs(dy) > math.abs(dx) and (dx > 0 and 3 or 1) or (dy > 0 and 0 or 2)
		end
		if poi.rotation == nil and includes(poi.type, warehouseTypes) then
			poi.rotation = (math.abs(dy) > math.abs(dx) and 0 or 1) + (sm.noise.intNoise2d(poi.x, poi.y, g_cellData.seed + 211) % 2) * 2
		end

		if includes(poi.type, inlineTypes) then
			if not poi.roaded then
				addNode(poi.x, poi.y)
				if poi.rotation % 2 == 0 then joinEast(poi.x - 1, poi.y, true); joinEast(poi.x, poi.y, true)
				else joinNorth(poi.x, poi.y - 1, true); joinNorth(poi.x, poi.y, true) end
				poi.roaded = true
			end
			if poi.rotation % 2 == 0 then return dx > 0 and -1 or 1, 0 end
			return 0, dy > 0 and -1 or 1
		end

		if includes(poi.type, mediumTypes) then
			local nodeSets = {
				[0]={{-1,-1},{0,-1}}, [1]={{0,-1},{0,0}}, [2]={{-1,0},{0,0}}, [3]={{-1,-1},{-1,0}}
			}
			if not poi.roaded then
				addOffsetNodes(poi, nodeSets[poi.rotation])
				if poi.rotation == 0 then addOffsetEdges(poi, {{-2,-1},{-1,-1},{0,-1}}, false, true)
				elseif poi.rotation == 1 then addOffsetEdges(poi, {{0,-2},{0,-1},{0,0}}, true, true)
				elseif poi.rotation == 2 then addOffsetEdges(poi, {{-2,0},{-1,0},{0,0}}, false, true)
				else addOffsetEdges(poi, {{-1,-2},{-1,-1},{-1,0}}, true, true) end
				poi.roaded = true
			end
			if poi.rotation == 0 then return dx > 0 and -2 or 1, -1 end
			if poi.rotation == 1 then return 0, dy > 0 and -2 or 1 end
			if poi.rotation == 2 then return dx > 0 and -2 or 1, 0 end
			return -1, dy > 0 and -2 or 1
		end

		if includes(poi.type, warehouseTypes) then
			if not poi.roaded then
				if poi.rotation % 2 == 0 then
					addOffsetNodes(poi, {{-1,-2},{0,1}})
					joinNorth(poi.x - 1, poi.y - 3, true); joinNorth(poi.x, poi.y + 1, true)
					shortcut(poi.x - 1, poi.y - 2, poi.x, poi.y + 1)
				else
					addOffsetNodes(poi, {{-2,0},{1,-1}})
					joinEast(poi.x - 3, poi.y, true); joinEast(poi.x + 1, poi.y - 1, true)
					shortcut(poi.x - 2, poi.y, poi.x + 1, poi.y - 1)
				end
				poi.roaded = true
			end
			if poi.rotation % 2 == 0 then return dy > 0 and -1 or 0, dy > 0 and -3 or 2 end
			return dx > 0 and -3 or 2, dx > 0 and 0 or -1
		end

		if includes(poi.type, {POI_RUINCITY_XL, POI_MEADOW_GROWLAB_SILODISTRICT_XL}) then
			if not poi.roaded then
				addOffsetNodes(poi, {{3,-1},{0,3},{-4,0},{-1,-4}})
				joinEast(poi.x + 3, poi.y - 1, true); joinNorth(poi.x, poi.y + 3, true)
				joinEast(poi.x - 5, poi.y, true); joinNorth(poi.x - 1, poi.y - 5, true)
				shortcut(poi.x+3,poi.y-1,poi.x,poi.y+3); shortcut(poi.x,poi.y+3,poi.x-4,poi.y)
				shortcut(poi.x-4,poi.y,poi.x-1,poi.y-4); shortcut(poi.x-1,poi.y-4,poi.x+3,poi.y-1)
				poi.roaded = true
			end
			if dx > 0 and dx > math.abs(dy) then return -5, 0 end
			if dx < 0 and dx < -math.abs(dy) then return 4, -1 end
			if dy > 0 then return -1, -5 end
			return 0, 4
		end

		if poi.type == POI_CAMP_LARGE then
			if not poi.roaded then addNode(poi.x+1,poi.y-2); joinEast(poi.x+1,poi.y-2,true); joinNorth(poi.x+1,poi.y-3,true); poi.roaded=true end
			if dx > 0 or dy > 0 then return 1,-3 end
			return 2,-2
		end
		if poi.type == POI_EXCAVATION_BRIDGE then
			if not poi.roaded then addNode(poi.x,poi.y); joinEast(poi.x-1,poi.y,true); poi.roaded=true end
			return -1,0
		end
		if poi.type == POI_BUILDERQUEST_WOCHOUSE then poi.roaded=true; return 0,1 end
		sm.log.error("Error road connection", poi.type, poi.x, poi.y)
		return 0,0
	end

	local function route(x0, y0, x1, y1, aPoi, bPoi)
		local a, b = nodes[y0][x0], nodes[y1][x1]
		if not a or not b then
			sm.log.error("Error finding road from",x0,y0,"to",x1,y1)
			if not a then sm.log.error("\ta is nil",aPoi.type,aPoi.terrainType) end
			if not b then sm.log.error("\tb is nil",bPoi.type,bPoi.terrainType) end
			return
		end
		for _, row in pairs(nodes) do for _, node in pairs(row) do node.dist=math.huge end end
		writeDistancesInNodes(a,b)
		local node, count = a, 0
		while node ~= b do
			local edge = cheaperPathStep(node)
			if not edge then sm.log.error("No path found!"); break end
			edge.cost, edge.road = 1, true
			for _, reverse in ipairs(edge.n.edges) do
				if reverse.n == node then reverse.cost, reverse.road = 1, true; break end
			end
			node, count = edge.n, count + 1
			if count > 1000 then sm.log.error("Road search path too long",x0,y0,x1,y1); break end
		end
	end

	for _, edge in ipairs(roadEdges) do
		local ax, ay = connectionPoint(edge.a, edge.b)
		local bx, by = connectionPoint(edge.b, edge.a)
		if edge.a.x + ax < edge.b.x + bx then
			route(edge.a.x+ax,edge.a.y+ay,edge.b.x+bx,edge.b.y+by,edge.a,edge.b)
		else
			route(edge.b.x+bx,edge.b.y+by,edge.a.x+ax,edge.a.y+ay,edge.b,edge.a)
		end
	end
	print("Random road pois:",randomRoadPoiCount)

	for _, row in pairs(nodes) do
		for _, node in pairs(row) do
			node.dist = nil
			removeFromArray(node.edges,function(edge) return not edge.road and not edge.shortcut end)
			if #node.edges == 0 then nodes[node.y][node.x] = nil end
		end
	end
	return nodes
end
