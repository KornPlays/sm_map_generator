-- Project-owned Chapter 2 overworld orchestration.

dofile("$SURVIVAL_DATA/Scripts/util.lua")
dofile("$SURVIVAL_DATA/Scripts/terrain/overworld/overworld_util.lua")
dofile("$SURVIVAL_DATA/Scripts/terrain/overworld/processing.lua")
dofile("$SURVIVAL_DATA/Scripts/terrain/overworld/generate_roads.lua")
dofile("$SURVIVAL_DATA/Scripts/terrain/overworld/biome_roads.lua")

ExcavationIsland={x=32,y=16,worldFile="$SURVIVAL_DATA/Terrain/Worlds/overworld_excavation_island.world",rotation=0}

local function add(list,value) list[#list+1]=value; return value end

local function boxFalloff(x,y,cx,cy,innerW,innerH,outerW,outerH)
	local horizontal=math.max(math.abs(x-cx)-innerW,0)/(outerW-innerW)
	local vertical=math.max(math.abs(y-cy)-innerH,0)/(outerH-innerH)
	return 1-math.min(math.max(horizontal,vertical),1)
end

local function buildNoise(seed)
	local simplexSeed=seed%32768
	local function islandShape(x,y)
		local value=boxFalloff(x,y,0,0,40,24,64,48)
		value=math.max(value-boxFalloff(x,y,-36,-38,8,4,16,16),0)
		value=math.max(value-boxFalloff(x,y,48,32,16,16,24,24),0)
		value=math.min(value+boxFalloff(x,y,-29,-26,3,3,5,5),1)
		value=math.min(value+boxFalloff(x,y,27,37,4,4,12,12),1)
		assert(value>=0 and value<=1)
		return value*2-1
	end
	local function islandNoise(x,y)
		local noise=sm.noise.simplexNoise2d((x+256*(simplexSeed+10))/8,(y+256*(simplexSeed+21))/8)
		return clamp(islandShape(x,y)+noise,-1,1)
	end
	local function cliffNoise(x,y)
		local first=boxFalloff(x,y,0,-15,0,0,15,30)
		local firstNoise=math.abs(sm.noise.simplexNoise2d((x+256*(simplexSeed+123))/10,(y+256*(simplexSeed+404))/10))
		local second=boxFalloff(x,y,0,30,0,0,20,10)
		local secondNoise=math.abs(sm.noise.simplexNoise2d((x+256*(simplexSeed+123))/10,(y+256*(simplexSeed+404))/10))
		return math.floor(first*4+firstNoise)+math.floor(second*4+secondNoise)
	end
	local function extraCliffNoise(x,y)
		local gate=sm.noise.simplexNoise2d((x+256*(simplexSeed+73))/7,(y+256*(simplexSeed+75))/7)
		local a=sm.noise.simplexNoise2d((x+256*(simplexSeed+66))/11,(y+256*(simplexSeed+274))/11)
		local b=sm.noise.simplexNoise2d((x+256*(simplexSeed+127))/22,(y+256*(simplexSeed+421))/22)
		return gate>0.5 and clamp(math.floor(math.abs(a*4+b*2)),0,3) or 0
	end
	local function elevationNoise(x,y)
		local center=g_cornerTemp.gradC[y][x]
		local value=0.1+clamp((center*3-1)*0.1,0,1)
		value=value+sm.noise.perlinNoise2d(x/16,y/16,seed+7907)*clamp(center*3-1,0,1)
		value=value+sm.noise.perlinNoise2d(x/8,y/8,seed+5527)*0.5
		value=value+sm.noise.perlinNoise2d(x/4,y/4,seed+8733)*0.25
		value=value+sm.noise.perlinNoise2d(x/2,y/2,seed+5442)*0.125
		return value*250
	end
	return islandShape,islandNoise,cliffNoise,extraCliffNoise,elevationNoise
end

local function initializeCorners(xMin,xMax,yMin,yMax,padding)
	g_cornerTemp={terrainType={},gradC={},forceFlat={},lakeAdjacent={},hillyness={}}
	local width=xMax+1-xMin
	local height=yMax+1-yMin
	local centerX=xMin+width/2
	local centerY=yMin+height/2
	local edgePadding=padding+4
	for y=yMin,yMax+1 do
		g_cornerTemp.terrainType[y]={}; g_cornerTemp.gradC[y]={}; g_cornerTemp.forceFlat[y]={}
		g_cornerTemp.lakeAdjacent[y]={}; g_cornerTemp.hillyness[y]={}
		for x=xMin,xMax+1 do
			g_cornerTemp.terrainType[y][x]=TYPE_LAKE
			g_cornerTemp.forceFlat[y][x]=false; g_cornerTemp.lakeAdjacent[y][x]=false; g_cornerTemp.hillyness[y][x]=1
			local gradient=1-math.min(math.max(math.abs(x-centerX)/(width/2-edgePadding),math.abs(y-centerY)/(height/2-edgePadding)),1)
			assert(gradient>=0 and gradient<=1); g_cornerTemp.gradC[y][x]=gradient
		end
	end
end

local function createPoiCatalog()
	local pois,refs={},{ }
	local fixed={
		{"crashArea",-36,-40,POI_CRASHSITE_AREA,20,false,false,nil,nil,0},
		{"crashExit",-35,-30,POI_ROAD_RANDOM,1,true,false,1,TYPE_FOREST,0,3},
		{"mechanic",-29,-26,POI_MECHANICSTATION_QUEST_MEDIUM,2,true,true,nil,TYPE_FOREST,0},
		{nil,-16,-16,POI_HIDEOUT_XL,8,false,true,0,nil,0,nil,true},
		{nil,-12,-29,POI_AUTUMNFOREST_CLEARRUINSQUEST_MEDIUM,2,false,true,nil,nil,0},
		{nil,-33,23,POI_BUNK_BURIAL_QUEST_MEDIUM,2,false,true},
		{nil,-38,-17,POI_MEADOW_GROWLAB_QUEST_LARGE,4,false,true,1,nil,nil,nil,nil,4},
		{"warehouseQuest",32,-12,POI_WAREHOUSE4_QUEST_LARGE,4,true,true,nil,nil,nil,nil,nil,4},
		{"packing1",-17,-23,POI_PACKINGSTATIONVEG_MEDIUM,2,true,true,nil,nil,0},
		{"packing2",10,10,POI_PACKINGSTATIONFRUIT_MEDIUM,2,true,true},
		{"wocHouse",-23,-25,POI_BUILDERQUEST_WOCHOUSE,1,true,false,0},
		{"ruinCity",0,15,POI_RUINCITY_XL,8,true,true,0,nil,nil,nil,true},
		{nil,8,-2,POI_MEADOW_GROWLAB_SILODISTRICT_XL,8,true,true,2,nil,nil,nil,true},
		{nil,-41,18,POI_BURNTFOREST_GROWLAB_FROZEN_LARGE,4,false,true,nil,nil,nil,nil,nil,4},
		{nil,-13,29,POI_FOREST_GROWLAB_STATION_LARGE,4,false,true,nil,nil,nil,nil,nil,4},
		{nil,-60,44,POI_LAKE_GROWLAB_ISLAND_XL,8,false,true,nil,nil,nil,nil,true},
		{nil,5,-23,POI_DESERT_GROWLAB_CLIFFTOP_LARGE,4,false,true,nil,nil,nil,nil,nil,4},
		{"resourceCar",-30,-20,POI_BUILDERQUEST_RESOURCECAR,1,true,true},
		{nil,-48,36,POI_CRASHEDSHIP_LARGE,4,false,true,3},
		{"campLarge",-31,0,POI_CAMP_LARGE,4,true,true,3,nil,nil,nil,nil,4},
		{nil,24,-20,POI_LABYRINTH_MEDIUM,2,false,true,nil,TYPE_FIELD},
		{nil,12,24,POI_MECHANICSTATION_MEDIUM,2,true,true},
		{nil,-26,-22,POI_SERVICE_ELEVATOR,1,false,true,2},
		{nil,ExcavationIsland.x+16,ExcavationIsland.y+16,POI_EXCAVATION,32,nil,true,nil,nil,0},
		{"excavationBridge",ExcavationIsland.x-1,ExcavationIsland.y+18,POI_EXCAVATION_BRIDGE,1,true,true,0,nil,0}
	}
	for _,s in ipairs(fixed) do
		local poi={x=s[2],y=s[3],type=s[4],size=s[5],road=s[6],flat=s[7],rotation=s[8],terrainType=s[9],cliffLevel=s[10],index=s[11],forceFlat=s[12],elevationSmoothing=s[13]}
		add(pois,poi); if s[1] then refs[s[1]]=poi end
	end

	local large={
		{POI_WAREHOUSE2_LARGE,1},{POI_WAREHOUSE2_LARGE,2},{POI_WAREHOUSE2_LARGE,3},
		{POI_BURNTFOREST_FARMBOTSCRAPYARD_LARGE,1,false},{POI_WAREHOUSE2_LARGE,4},
		{POI_WAREHOUSE3_LARGE,1},{POI_BURNTFOREST_FARMBOTSCRAPYARD_LARGE,2,false},
		{POI_WAREHOUSE3_LARGE,1},{POI_WAREHOUSE4_LARGE,1},{POI_WAREHOUSE4_LARGE,1}
	}
	for _,entry in ipairs(large) do entry.type=entry[1];entry.index=entry[2];entry.size=4;entry.road=entry[3]~=false;entry.flat=true;entry.elevationSmoothing=4 end

	local chemicals={1,2,3}; shuffle(chemicals)
	local must={
		{POI_BUILDERQUEST_CARDBOARDPOOP,1,0,false,false},
		{POI_BURNTFOREST_BUILDERQUEST_TOTEBOTKEY,1,0,false,false},
		{POI_FIELD_BUILDERQUEST_CORNHEART,1,0,false,false},
		{POI_CHEMLAKE_MEDIUM,2,nil,false,true,chemicals[1]},
		{POI_FIELD_BUILDERQUEST_COZYBED,1,0,false,false},
		{POI_BUILDERQUEST_XYLOPHONE,1,0,false,false},
		{POI_BUILDERQUEST_BEESUIT,1,0,false,false},
		{POI_DESERT_BUILDERQUEST_BIGFAN,1,0,false,false},
		{POI_CHEMLAKE_MEDIUM,2,nil,false,true,chemicals[2]},
		{POI_BUILDERQUEST_CAROUSEL,1,0,false,false},
		{POI_BURNTFOREST_BUILDERQUEST_CATAPULT_MEDIUM,2,0,false,false},
		{POI_BUILDERQUEST_CROWBAR,1,0,false,false},
		{POI_BUILDERQUEST_COMPASS,1,0,false,false},
		{POI_DESERT_BUILDERQUEST_GARDEN,1,0,false,false},
		{POI_CHEMLAKE_MEDIUM,2,nil,false,true,chemicals[3]},
		{POI_FOREST_BUILDERQUEST_SAWBLADEARM,1,0,false,false},
		{POI_AUTUMNFOREST_BUILDERQUEST_POPCORN,1,0,false,false},
		{POI_AUTUMNFOREST_BUILDERQUEST_MUSICBOX_MEDIUM,2,0,false,false},
		{POI_BUILDERQUEST_NICEHOUSE_MEDIUM,2,0,false,false},
		{POI_BUILDERQUEST_SLEDGEHAMMER_MEDIUM,2,0,false,true},
		{POI_BUILDERQUEST_STEELBRIDGE_MEDIUM,2,0,false,true},
		{POI_BUILDERQUEST_BAGUETTE_MEDIUM,2,0,false,true},
		{POI_OILLAKE_MEDIUM,2,nil,false,true}
	}
	for _,entry in ipairs(must) do entry.type=entry[1];entry.size=entry[2];entry.rotation=entry[3];entry.road=entry[4];entry.flat=entry[5];entry.index=entry[6] end
	return pois,refs,large,must
end

local function checkBounds(pois,xMin,xMax,yMin,yMax)
	for _,poi in ipairs(pois) do
		local half=math.floor(poi.size/2)
		assert(poi.x+half>xMin and poi.x-half<xMax and poi.y+half>yMin and poi.y-half<yMax,"POI outside generation bounds: "..poi.type)
	end
end

local function createTerrainBalancer()
	local terrainTypes={TYPE_MEADOW,TYPE_FOREST,TYPE_DESERT,TYPE_FIELD,TYPE_BURNTFOREST,TYPE_AUTUMNFOREST,TYPE_LAKE}
	local weights={[TYPE_MEADOW]=2,[TYPE_FOREST]=2,[TYPE_DESERT]=1,[TYPE_FIELD]=1,[TYPE_BURNTFOREST]=1,[TYPE_AUTUMNFOREST]=1,[TYPE_LAKE]=2}
	local counts={[TYPE_MEADOW]=0,[TYPE_FOREST]=0,[TYPE_DESERT]=0,[TYPE_FIELD]=0,[TYPE_BURNTFOREST]=0,[TYPE_AUTUMNFOREST]=0,[TYPE_LAKE]=0}
	for _,terrainType in ipairs(terrainTypes) do weights[terrainType]=weights[terrainType]/10 end
	local total=0
	local function choose(forced)
		local selected=forced
		if not selected then
			if total==0 then selected=TYPE_FOREST else
				local minimum=1
				for _,terrainType in ipairs(terrainTypes) do
					local ratio=counts[terrainType]/total/weights[terrainType]
					if ratio<minimum then selected,minimum=terrainType,ratio end
				end
				assert(selected~=nil)
			end
		end
		counts[selected]=counts[selected]+1; total=total+1; return selected
	end
	return choose
end

local function copyTemplate(template,x,y,terrainType)
	return {x=x,y=y,type=template.type,index=template.index,rotation=template.rotation,size=template.size,road=template.road,flat=template.flat,forceFlat=template.forceFlat,elevationSmoothing=template.elevationSmoothing,terrainType=terrainType}
end

local function placeCatalog(pois,refs,largeTemplates,mustTemplates,chooseTerrain,islandShape,islandNoise,seed)
	for _,poi in ipairs(pois) do
		if poi.terrainType==nil then poi.terrainType=math.max(math.floor(poi.type/100),1) end
		chooseTerrain(poi.terrainType)
	end

	local largeSpots={}
	for row=1,5 do for column=1,5+(row-1)%2 do
		local spot={x=column*20-70+row%2*10,y=row*16-48}
		if (row>2 or column>3) and not collides(spot.x,spot.y,8,pois) then add(largeSpots,spot) end
	end end
	table.sort(largeSpots,function(a,b) return a.x+a.y+sm.noise.intNoise2d(a.x,a.y,seed+345)%75 < b.x+b.y+sm.noise.intNoise2d(b.x,b.y,seed+345)%75 end)
	assert(#largeSpots>=#largeTemplates)
	while #largeSpots>#largeTemplates do table.remove(largeSpots,math.random(#largeSpots)) end
	for index,template in ipairs(largeTemplates) do
		local spot=largeSpots[index]
		add(pois,copyTemplate(template,spot.x,spot.y,chooseTerrain(math.floor(template.type/100))))
	end

	local excluded={[refs.crashExit]=true,[refs.mechanic]=true,[refs.wocHouse]=true,[refs.resourceCar]=true,[refs.packing1]=true,[refs.packing2]=true,[refs.warehouseQuest]=true,[refs.excavationBridge]=true}
	local destinations={}
	for _,poi in ipairs(pois) do if poi.road and not excluded[poi] then add(destinations,poi) end end

	local mustSpots,randomSpots={},{}
	for row=1,15 do for column=1,21 do
		local noise=sm.noise.intNoise2d(column,row,seed+557)
		local x=column*6-66+noise%3-1
		local y=row*6-50+(column%2)*3
		if not collides(x,y,8,pois) then
			local destination=(islandShape(x,y)>0.25 and not (x< -8 and y< -8)) and mustSpots or randomSpots
			add(destination,{x=x,y=y})
		end
	end end
	table.sort(mustSpots,function(a,b) return a.x+a.y+sm.noise.intNoise2d(a.x,a.y,seed+653)%24 < b.x+b.y+sm.noise.intNoise2d(b.x,b.y,seed+653)%24 end)
	local used={}
	local step=#mustSpots/#mustTemplates
	local first=math.random(math.ceil(step))
	for index=1,#mustTemplates do used[index]=math.floor((index-1)*step)+first end
	for index,template in ipairs(mustTemplates) do
		local spot=mustSpots[used[index]]
		local dx=template.size==1 and -(sm.noise.intNoise2d(spot.x,spot.y,g_cellData.seed+852)%2) or 0
		local dy=template.size==1 and -(sm.noise.intNoise2d(spot.x,spot.y,g_cellData.seed+299)%2) or 0
		add(pois,copyTemplate(template,spot.x+dx,spot.y+dy,chooseTerrain(math.floor(template.type/100))))
	end
	local usedIndex=1
	for index,spot in ipairs(mustSpots) do
		if usedIndex<=#used and index==used[usedIndex] then usedIndex=usedIndex+1 else add(randomSpots,spot) end
	end

	table.sort(randomSpots,function(a,b) return a.x+a.y+sm.noise.intNoise2d(a.x,a.y,seed+603)%24 < b.x+b.y+sm.noise.intNoise2d(b.x,b.y,seed+603)%24 end)
	local beginningCounter=0
	for _,spot in ipairs(randomSpots) do
		local terrainType
		if islandNoise(spot.x,spot.y)>=0 then
			local forced
			if spot.x< -8 and spot.y< -8 then
				local sequence={TYPE_MEADOW,TYPE_FOREST,TYPE_MEADOW,TYPE_FIELD}
				forced=sequence[beginningCounter%#sequence+1]; beginningCounter=beginningCounter+1
			end
			terrainType=chooseTerrain(forced)
		else terrainType=TYPE_LAKE end
		add(pois,{x=spot.x,y=spot.y,type=POI_RANDOM_PLACEHOLDER,size=2,road=true,flat=false,terrainType=terrainType})
	end
	return destinations
end

local function createRoadNetwork(pois,refs,destinations)
	local roadPois={}; preparePoiRoadGraph(pois,roadPois)
	local edges={}
	local pairsToConnect={{refs.crashExit,refs.mechanic},{refs.mechanic,refs.wocHouse},{refs.wocHouse,refs.packing1},{refs.wocHouse,refs.resourceCar},{refs.resourceCar,refs.campLarge},{refs.packing1,refs.warehouseQuest},{refs.warehouseQuest,refs.ruinCity},{refs.ruinCity,refs.packing2},{refs.packing2,refs.excavationBridge}}
	for _,pair in ipairs(pairsToConnect) do findRoadPath(roadPois,edges,pair[1],pair[2]) end
	shuffle(destinations)
	local previous=refs.packing2
	for _,destination in ipairs(destinations) do findRoadPath(roadPois,edges,previous,destination); previous=destination end
	for _,poi in ipairs(roadPois) do poi.dist=math.huge end
	writeDistancesInNodes(nil,refs.crashExit)
	table.sort(edges,function(a,b) return math.min(a.a.dist,a.b.dist)<math.min(b.a.dist,b.b.dist) end)
	return drawRoads(edges,pois)
end

local function addExtraCliffs(pois,roadNodes,padding,noise)
	local function terrainIs(x,y,terrainType) return insideCornerBounds(x,y) and g_cornerTemp.terrainType[y][x]==terrainType end
	forEveryCorner(function(x,y)
		if collides(x,y,2,pois) then return end
		local valid=true
		local minimum=g_cellData.cliffLevel[y][x]
		for cy=y-1,y+1 do for cx=x-1,x+1 do
			if not terrainIs(cx,cy,TYPE_MEADOW) then valid=false; break end
			minimum=math.min(minimum,g_cellData.cliffLevel[cy][cx])
		end end
		for cy=y-1,y do for cx=x-1,x do if hasRoad(cx,cy,roadNodes) then valid=false; break end end end
		if valid then g_cellData.cliffLevel[y][x]=minimum+noise(x,y) end
	end,padding)
end

local function forceDistantRoadEdgeToMeadow(from,to)
	local dx,dy=to.x-from.x,to.y-from.y
	local terrain=g_cornerTemp.terrainType
	if dx==-1 then terrain[to.y][to.x]=TYPE_MEADOW;terrain[to.y+1][to.x]=TYPE_MEADOW
	elseif dx==1 then terrain[to.y][to.x+1]=TYPE_MEADOW;terrain[to.y+1][to.x+1]=TYPE_MEADOW
	elseif dy==-1 then terrain[to.y][to.x]=TYPE_MEADOW;terrain[to.y][to.x+1]=TYPE_MEADOW
	elseif dy==1 then terrain[to.y+1][to.x]=TYPE_MEADOW;terrain[to.y+1][to.x+1]=TYPE_MEADOW end
end

local function meadowCell(node)
	local terrain=g_cornerTemp.terrainType
	terrain[node.y][node.x]=TYPE_MEADOW;terrain[node.y][node.x+1]=TYPE_MEADOW
	terrain[node.y+1][node.x]=TYPE_MEADOW;terrain[node.y+1][node.x+1]=TYPE_MEADOW
end

local function straightRoadSpot(list,node)
	local bits=bit.band(g_cellData.flags[node.y][node.x],MASK_ROADCLIFF)
	if bits==MASK_ROADS_SN or bits==MASK_ROADS_WE then add(list,{x=node.x,y=node.y}) end
end

local function paintBiomeRoads(roadNodes,startPoi)
	local potential={}
	local start=roadNodes[startPoi.y][startPoi.x]
	local stack={start}; local visited={[start]=true}; local trace={}; local ends={}; local traceId=0

	local function updateBranchIds(node)
		local id=trace[node].id
		for _,edge in ipairs(node.edges) do
			if trace[edge.n] and trace[edge.n].parent==node and trace[edge.n].id~=id then trace[edge.n].id=id;updateBranchIds(edge.n) end
		end
	end
	local reverse
	reverse=function(node,collision)
		local oldParent=trace[node].parent
		if trace[oldParent] then trace[oldParent].children=trace[oldParent].children-1 end
		trace[collision].children=trace[collision].children+1
		trace[node].parent=collision;trace[node].id=trace[collision].id;updateBranchIds(node)
		if oldParent then reverse(oldParent,node) else trace[node].children=trace[node].children+1;add(ends,node) end
	end

	while #stack>0 do
		local node=stack[#stack];stack[#stack]=nil
		for _,edge in ipairs(node.edges) do if edge.road or edge.shortcut then
			if not visited[edge.n] then
				visited[edge.n]=true
				if not getBiomeRoadTile(edge.n) then forceDistantRoadEdgeToMeadow(node,edge.n) end
				if getBiomeRoadTile(edge.n) then
					assert(trace[edge.n]==nil)
					if trace[node] then trace[node].children=trace[node].children+1;trace[edge.n]={parent=node,children=0,origin=node,id=trace[node].id}
					else traceId=traceId+1;trace[edge.n]={parent=nil,children=0,origin=node,id=traceId} end
				else
					meadowCell(edge.n)
					if trace[node] then trace[node].children=trace[node].children+1;add(ends,node) end
					straightRoadSpot(potential,edge.n)
				end
				add(stack,edge.n)
			elseif trace[node] then
				if trace[edge.n] and trace[node].id~=trace[edge.n].id then reverse(node,edge.n);trace[node].children=trace[node].children+1;add(ends,node)
				elseif edge.n~=trace[node].origin then trace[node].children=trace[node].children+1;add(ends,node) end
			end
		end end
	end

	for _,first in ipairs(ends) do
		trace[first].children=trace[first].children-1
		local node=first
		while node do
			if trace[node].children>0 then break end
			local tile=getBiomeRoadTile(node)
			if tile then
				local noise=sm.noise.intNoise2d(node.x,node.y,g_cellData.seed+499)
				g_cellData.uid[node.y][node.x]=tile.tiles[noise%#tile.tiles+1]
				g_cellData.rotation[node.y][node.x]=tile.rotation;g_cellData.xOffset[node.y][node.x]=0;g_cellData.yOffset[node.y][node.x]=0
				if tile.terrainType then g_cellData.flags[node.y][node.x]=bit.bor(bit.band(g_cellData.flags[node.y][node.x],bit.bnot(MASK_TERRAINTYPE)),bit.band(bit.lshift(tile.terrainType,SHIFT_TERRAINTYPE),MASK_TERRAINTYPE)) end
			else meadowCell(node);straightRoadSpot(potential,node) end
			local parent=trace[node].parent;trace[node]=nil
			if parent then assert(trace[parent]);trace[parent].children=trace[parent].children-1 else break end
			node=parent
		end
	end
	return potential
end

local function placeRandomRoadPois(spots,pois,padding)
	shuffle(spots)
	local count=0
	for _,spot in ipairs(spots) do
		if not collides(spot.x,spot.y,3,pois) then
			local bits=bit.band(g_cellData.flags[spot.y][spot.x],MASK_ROADS)
			local poi={x=spot.x,y=spot.y,type=POI_ROAD_RANDOM,size=1,rotation=(bits==MASK_ROADS_SN and 1 or 0)+(sm.noise.intNoise2d(spot.x,spot.y,g_cellData.seed+211)%2)*2,road=true,flat=false,terrainType=TYPE_MEADOW,edges={}}
			writePoi(poi,padding);add(pois,poi);count=count+1
		end
		if count>=20 then break end
	end
end

local function buildElevation(pois,xMin,xMax,yMin,yMax,padding,elevationNoise)
	local function terrainIs(x,y,terrainType) return insideCornerBounds(x,y) and g_cornerTemp.terrainType[y][x]==terrainType end
	forEveryCorner(function(x,y)
		local adjacent=false
		for dy=-1,1 do for dx=-1,1 do adjacent=adjacent or terrainIs(x+dx,y+dy,TYPE_LAKE) end end
		g_cornerTemp.lakeAdjacent[y][x]=adjacent
		if adjacent then g_cornerTemp.hillyness[y][x]=-0.2 end
	end,padding)
	for _,poi in ipairs(pois) do if poi.type~=POI_CRASHSITE_AREA then setForcedAndLakeAdjacentPoiHillynessToZero(poi) end end

	for y=yMin,yMax+1 do
		for x=xMin+1,xMax+1 do
			local h=g_cornerTemp.hillyness[y][x]
			h=math.min(h,g_cornerTemp.hillyness[y][x-1]+0.2)
			if y>yMin then h=math.min(h,g_cornerTemp.hillyness[y-1][x-1]+0.2) end
			if y<yMax+1 then h=math.min(h,g_cornerTemp.hillyness[y+1][x-1]+0.2) end
			g_cornerTemp.hillyness[y][x]=h
		end
		for x=xMax,xMin+1,-1 do
			local h=g_cornerTemp.hillyness[y][x]
			h=math.min(h,g_cornerTemp.hillyness[y][x+1]+0.2)
			if y>yMin then h=math.min(h,g_cornerTemp.hillyness[y-1][x+1]+0.2) end
			if y<yMax+1 then h=math.min(h,g_cornerTemp.hillyness[y+1][x+1]+0.2) end
			g_cornerTemp.hillyness[y][x]=h
		end
	end
	for x=xMin,xMax+1 do
		for y=yMin+1,yMax+1 do
			local h=g_cornerTemp.hillyness[y][x]
			h=math.min(h,g_cornerTemp.hillyness[y-1][x]+0.2)
			if x>xMin then h=math.min(h,g_cornerTemp.hillyness[y-1][x-1]+0.2) end
			if x<xMax+1 then h=math.min(h,g_cornerTemp.hillyness[y-1][x+1]+0.2) end
			g_cornerTemp.hillyness[y][x]=h
		end
		for y=yMax,yMin+1,-1 do
			local h=g_cornerTemp.hillyness[y][x]
			h=math.min(h,g_cornerTemp.hillyness[y+1][x]+0.2)
			if x>xMin then h=math.min(h,g_cornerTemp.hillyness[y+1][x-1]+0.2) end
			if x<xMax+1 then h=math.min(h,g_cornerTemp.hillyness[y+1][x+1]+0.2) end
			g_cornerTemp.hillyness[y][x]=h
		end
	end
	forEveryCorner(function(x,y) local h=clamp(g_cornerTemp.hillyness[y][x],0,1);g_cellData.elevation[y][x]=elevationNoise(x,y)*h end,padding)
	for _,poi in ipairs(pois) do if poi.type~=POI_CRASHSITE_AREA then smoothPoiElevation(poi) end end
	forEveryCorner(function(x,y) local h=clamp(g_cornerTemp.hillyness[y][x],0,1);g_cellData.elevation[y][x]=g_cellData.elevation[y][x]*h end,padding)
	for _,poi in ipairs(pois) do if poi.type~=POI_CRASHSITE_AREA then flattenPoiElevation(poi) end end
end

function generateOverworldCelldata(xMin,xMax,yMin,yMax,seed,data,padding)
	sm.debugDraw.clear("overworld_dd_");math.randomseed(seed);initializeCellData(xMin,xMax,yMin,yMax,seed,padding)
	initializeCorners(xMin,xMax,yMin,yMax,padding)
	local islandShape,islandNoise,cliffNoise,extraCliffNoise,elevationNoise=buildNoise(seed)
	local pois,refs,largeTemplates,mustTemplates=createPoiCatalog()
	checkBounds(pois,xMin,xMax,yMin,yMax)
	local chooseTerrain=createTerrainBalancer()
	local destinations=placeCatalog(pois,refs,largeTemplates,mustTemplates,chooseTerrain,islandShape,islandNoise,seed)
	checkBounds(pois,xMin,xMax,yMin,yMax)
	for _,poi in ipairs(pois) do if not poi.cliffLevel then poi.cliffLevel=cliffNoise(poi.x,poi.y) end end
	forEveryCorner(function(x,y)
		if islandNoise(x,y)>=0 then
			local poi=closestPoi(pois,x,y)
			g_cornerTemp.terrainType[y][x]=(poi.terrainType==TYPE_LAKE and islandShape(x,y)<1) and TYPE_MEADOW or poi.terrainType
			g_cellData.cliffLevel[y][x]=poi.cliffLevel or 0
		else g_cornerTemp.terrainType[y][x]=TYPE_LAKE;g_cellData.cliffLevel[y][x]=0 end
	end,padding)

	local roadNodes=createRoadNetwork(pois,refs,destinations)
	convertPlaceholderPois(pois)
	for _,poi in ipairs(pois) do assert(poi.type~=POI_RANDOM_PLACEHOLDER and poi.type~=nil) end
	for _,poi in ipairs(pois) do if poi.type~=POI_CRASHSITE_AREA then flattenPoiCliff(poi);writePoi(poi,padding) end end
	writeStartArea(pois,roadNodes);injectExcavation(ExcavationIsland)
	enforceCliffRoadLimitations(roadNodes);addExtraCliffs(pois,roadNodes,padding,extraCliffNoise);evaluateRoadsAndCliffs(roadNodes)
	forEveryCell(function(x,y) if bit.band(g_cellData.flags[y][x],MASK_CLIFF)~=0 then meadowCell({x=x,y=y}) end end)
	addBorderingMeadows()
	placeRandomRoadPois(paintBiomeRoads(roadNodes,refs.crashExit),pois,padding)
	buildElevation(pois,xMin,xMax,yMin,yMax,padding,elevationNoise)
	addExtraPois(pois,padding)
	evaluateType(TYPE_MEADOW,getMeadowTileIdAndRotation);evaluateType(TYPE_FOREST,getForestTileIdAndRotation)
	evaluateType(TYPE_DESERT,getDesertTileIdAndRotation);evaluateType(TYPE_FIELD,getFieldTileIdAndRotation)
	evaluateType(TYPE_BURNTFOREST,getBurntForestTileIdAndRotation);evaluateType(TYPE_AUTUMNFOREST,getAutumnForestTileIdAndRotation)
	evaluateType(TYPE_LAKE,getLakeTileIdAndRotation)
	for y=yMin,yMax do for x=xMin,xMax do if g_cellData.uid[y][x]:isNil() then sm.log.error("Nil cell at: "..x.." "..y);ddDownArrow("nilcell",x,y,"ff0000") end end end
	g_cornerTemp=nil
end
