// Original test harness. Links the unmodified engine physics implementation.
#include <base/dbg.h>
#include <engine/map.h>
#include <engine/shared/config.h>
#include <game/collision.h>
#include <game/gamecore.h>
#include <game/layers.h>
#include <game/mapitems.h>

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <vector>

#include "warmup_fixture.h"

// Only assertion reporting and configuration storage are supplied by the harness.
// No CCharacterCore, CCollision or CTeamsCore method is mocked.
CConfig g_Config{};
extern "C" [[noreturn]] void dbg_assert_imp(const char *pFile, int Line, const char *pFormat, ...)
{
	std::fprintf(stderr, "%s:%d: ", pFile, Line);
	va_list Args;
	va_start(Args, pFormat);
	std::vfprintf(stderr, pFormat, Args);
	va_end(Args);
	std::exit(1);
}

static void Require(bool Condition, const char *pMessage)
{
	if(!Condition)
	{
		std::fprintf(stderr, "FAIL: %s\n", pMessage);
		std::exit(1);
	}
}

// Minimal in-memory IMap adapter, not a substitute DATA reader. Python's
// independent DATA reader exports the exact serialized Game/Tele payloads.
class CFixtureMap : public IMap
{
	CMapItemGroup m_Group{};
public:
	CFixtureMap()
	{
		m_Group.m_Version = 3;
		m_Group.m_NumLayers = 2;
		m_Group.m_ParallaxX = m_Group.m_ParallaxY = 100;
	}
	int GetDataSize(int Index) const override { return Index == 0 ? GameData.size() : TeleData.size(); }
	void *GetData(int Index) override { Require(Index == 0 || Index == 1, "unexpected raw block"); return Index == 0 ? GameData.data() : TeleData.data(); }
	void *GetDataSwapped(int Index) override { return GetData(Index); }
	const char *GetDataString(int) override { Require(false,"unexpected string read"); return nullptr; }
	void UnloadData(int) override {}
	int NumData() const override { return 2; }
	int GetItemSize(int Index) override { return Index == 0 ? sizeof(m_Group) : (Index == 1 ? GameItem.size() : TeleItem.size()) * sizeof(int); }
	void *GetItem(int Index, int *pType, int *pId, CUuid *) override
	{
		Require(Index >= 0 && Index < 3,"unexpected item");
		if(pType) *pType = Index == 0 ? MAPITEMTYPE_GROUP : MAPITEMTYPE_LAYER;
		if(pId) *pId = Index == 0 ? 0 : Index - 1;
		if(Index == 0) return &m_Group;
		return Index == 1 ? GameItem.data() : TeleItem.data();
	}
	void GetType(int Type, int *pStart, int *pNum) override
	{
		Require(Type == MAPITEMTYPE_GROUP || Type == MAPITEMTYPE_LAYER,"unexpected item type");
		*pStart = Type == MAPITEMTYPE_GROUP ? 0 : 1;
		*pNum = Type == MAPITEMTYPE_GROUP ? 1 : 2;
	}
	int FindItemIndex(int, int) override { Require(false,"unexpected find"); return -1; }
	void *FindItem(int, int) override { Require(false,"unexpected find"); return nullptr; }
	int NumItems() const override { return 3; }
	bool Load(const char *, IStorage *, const char *, int) override { return false; }
	bool Load(IStorage *, const char *, int) override { return false; }
	void Unload() override {}
	bool IsLoaded() const override { return true; }
	IOHANDLE File() const override { return nullptr; }
	const char *FullName() const override { return "Warmup test adapter"; }
	const char *BaseName() const override { return FullName(); }
	const char *Path() const override { return FullName(); }
	SHA256_DIGEST Sha256() const override { return {}; }
	unsigned Crc() const override { return 0; }
	int Size() const override { return 0; }
};

static void Step(CCharacterCore &Core)
{
	Core.Tick(true);
	Core.Move();
	Core.Quantize();
}

static void Place(CCharacterCore &Core, vec2 Position)
{
	Core.m_Input = {};
	Core.Reset();
	Core.m_Solo = true;
	Core.m_Pos = Position;
}

int main(int Argc, char **ppArgv)
{
	Require(Argc <= 2, "unexpected arguments");
	if(Argc == 2)
	{
		const bool NoHook = std::strcmp(ppArgv[1], "--no-hook") == 0;
		Require(NoHook || std::strcmp(ppArgv[1], "--no-finish") == 0, "unknown negative control");
		for(size_t i = 0; i < GameData.size(); i += sizeof(CTile))
		{
			if(NoHook && GameData[i] == TILE_SOLID) GameData[i] = TILE_NOHOOK;
			if(!NoHook && GameData[i] == TILE_FINISH) GameData[i] = TILE_AIR;
		}
	}
	CFixtureMap Map;
	CLayers Layers;
	Layers.Init(&Map, false, false);
	CCollision Collision;
	Collision.Init(&Layers);
	CWorldCore World;
	CTeamsCore Teams;
	CCharacterCore Core{};
	Core.Init(&World, &Collision, &Teams);
	Core.Reset();
	Core.m_Id = 0;
	Core.m_Solo = true;
	Teams.SetSolo(0, true);
	World.m_apCharacters[0] = &Core;
	Core.m_Pos = vec2(5.5f * 32, 35.5f * 32);
	bool Start = false, Finish = false;
	const float aTargets[] = {28, 53, 69, 86, 117, 161};
	int Target = 0;
	int Jumps = 0, Attachments = 0, Checkpoint = 0, Tick = 0;
	for(; Tick < 2000 && !Finish; ++Tick)
	{
		const bool Grounded = Collision.IsOnGround(Core.m_Pos, Core.PhysicalSize());
		const bool StepAhead = Collision.CheckPoint(Core.m_Pos.x + 36, Core.m_Pos.y);
		const bool GapAhead = !Collision.CheckPoint(Core.m_Pos.x + 48, Core.m_Pos.y + 20);
		if(Grounded && std::abs(Core.m_Pos.x / 32 - aTargets[Target]) < 1 && Target < 5) ++Target;
		const float DesiredVelocity = std::clamp((aTargets[Target] * 32 - Core.m_Pos.x) * .2f, -10.0f, 10.0f);
		Core.m_Input.m_Direction = DesiredVelocity > Core.m_Vel.x + .5f ? 1 : (DesiredVelocity < Core.m_Vel.x - .5f ? -1 : 0);
		Core.m_Input.m_Jump = Grounded && (StepAhead || GapAhead);
		const float X = Core.m_Pos.x / 32;
		Core.m_Input.m_Hook = X >= 91 && X < 113 && Tick % 35 != 0;
		Core.m_Input.m_TargetX = 96;
		Core.m_Input.m_TargetY = -300;
		Step(Core);
		Jumps += (Core.m_TriggeredEvents & COREEVENT_GROUND_JUMP) != 0;
		Attachments += (Core.m_TriggeredEvents & COREEVENT_HOOK_ATTACH_GROUND) != 0;
		const int Index = Collision.GetPureMapIndex(Core.m_Pos);
		Start |= Collision.GetTileIndex(Index) == TILE_START;
		Finish |= Collision.GetTileIndex(Index) == TILE_FINISH;
		Checkpoint = std::max(Checkpoint, Collision.IsTeleCheckpoint(Index));
		if(Collision.IsCheckEvilTeleport(Index))
		{
			std::fprintf(stderr,"route fell into oil at tick %d pos %.2f %.2f\n",Tick,Core.m_Pos.x/32,Core.m_Pos.y/32);
			break;
		}
	}
	std::printf("route: ticks=%d position=(%.2f,%.2f) jumps=%d hooks=%d checkpoints=%d start=%d finish=%d\n",Tick,Core.m_Pos.x/32,Core.m_Pos.y/32,Jumps,Attachments,Checkpoint,Start,Finish);
	Require(Attachments > 0, "hook attachment");
	Require(Start && Finish && Jumps >= 4 && Checkpoint == 3, "continuous route reaches start/finish and checkpoints");
	std::puts("PASS: native core route (not server race completion)");

	// Beginner approach: hold right, jump before steps/gaps; no air braking,
	// no double jump and no hook on the first three islands.
	Place(Core, vec2(5.5f * 32, 35.5f * 32));
	int EasyTicks = 0;
	bool EasyLanded = false;
	for(; EasyTicks < 1000 && !EasyLanded; ++EasyTicks)
	{
		Core.m_Input.m_Direction = 1;
		Core.m_Input.m_Jump = Collision.IsOnGround(Core.m_Pos, Core.PhysicalSize()) &&
			(Collision.CheckPoint(Core.m_Pos.x + 36, Core.m_Pos.y) ||
				!Collision.CheckPoint(Core.m_Pos.x + 48, Core.m_Pos.y + 20));
		Step(Core);
		if(Collision.IsCheckEvilTeleport(Collision.GetPureMapIndex(Core.m_Pos))) std::fprintf(stderr, "beginner fell: %.2f %.2f\n", Core.m_Pos.x/32,Core.m_Pos.y/32);
		Require(!Collision.IsCheckEvilTeleport(Collision.GetPureMapIndex(Core.m_Pos)), "beginner approach fell into oil");
		EasyLanded = Core.m_Pos.x > 79 * 32 && Core.m_Pos.x < 93 * 32 && Collision.IsOnGround(Core.m_Pos, Core.PhysicalSize());
	}
	Require(EasyLanded, "beginner approach must land on third island");
	std::puts("PASS: first three islands approached without air braking/double-jump/hook");

	Place(Core, vec2(10.5f * 32, 34.0f * 32));
	Core.m_Input.m_TargetY = 100;
	Core.m_Input.m_Hook = 1;
	bool NoHookRejected = false;
	for(int i = 0; i < 12; ++i)
	{
		Step(Core);
		NoHookRejected |= (Core.m_TriggeredEvents & COREEVENT_HOOK_HIT_NOHOOK) != 0;
		Require(Core.m_HookState != HOOK_GRABBED, "no-hook floor attached");
	}
	Require(NoHookRejected, "no-hook material rejection");

	// These cases deliberately place a fixture in each pit. Core does not run
	// CCharacter::HandleTiles: test the native trigger and exits, not a fake timer.
	for(float X : {44.5f, 60.5f, 76.5f, 96.5f, 105.5f, 111.5f})
	{
		Place(Core, vec2(X * 32, 38.5f * 32));
		bool Trigger = false;
		for(int i = 0; i < 30 && !Trigger; ++i)
		{
			Step(Core);
			Trigger = Collision.IsCheckEvilTeleport(Collision.GetPureMapIndex(Core.m_Pos));
		}
		Require(Trigger, "fall must reach native evil-checkpoint trigger");
	}
	for(int Cp = 0; Cp < 3; ++Cp)
	{
		const auto &Outs = Collision.TeleCheckOuts(Cp);
		Require(Outs.size() == 1, "one deterministic checkpoint exit");
		Place(Core, Outs[0]);
		for(int i = 0; i < 30; ++i) Step(Core);
		Require(Collision.IsOnGround(Core.m_Pos, Core.PhysicalSize()), "checkpoint exit settles on ground");
		Require(!Collision.IsCheckEvilTeleport(Collision.GetPureMapIndex(Core.m_Pos)), "checkpoint exit is not a hazard");
		Require(std::abs(Core.m_Pos.x - Outs[0].x) < 1, "checkpoint exit does not eject sideways");
	}
	std::puts("PASS: 6 fall triggers / 3 stable checkpoint exits / no-hook rejection");

	CCharacterCore Other{};
	Other.Init(&World, &Collision, &Teams);
	Other.m_Id = 1;
	Teams.SetSolo(1, true);
	World.m_apCharacters[1] = &Other;
	Place(Core, vec2(11.5f * 32, 35.5f * 32));
	Place(Other, Core.m_Pos);
	for(int i = 0; i < 40; ++i)
	{
		Core.m_Input.m_Direction = Other.m_Input.m_Direction = 1;
		Step(Core);
		Step(Other);
		Require(Core.m_Pos == Other.m_Pos && Core.m_Vel == Other.m_Vel, "solo cores must not push each other");
	}
	World.m_apCharacters[1] = nullptr;
	std::puts("PASS: two overlapping solo cores do not push each other");
	std::printf("RESULT {\"route_ticks\":%d,\"ground_jumps\":%d,\"hook_attachments\":%d,\"checkpoint_columns\":%d,\"start_tile_reached\":true,\"finish_tile_reached\":true,\"fall_trigger_cases\":6,\"stable_exit_cases\":3,\"beginner_approach_ticks\":%d,\"solo_overlap_verified\":true,\"no_hook_rejection_verified\":true}\n", Tick,Jumps,Attachments,Checkpoint,EasyTicks);
}
