import sys
from engine.world import World

def test():
    try:
        print("Loading scenario...")
        world = World.from_yaml("scenarios/default_park.yaml")
        print("World loaded. Stepping...")
        world.step(0.5)
        print("Step 1 done.")
        world.step(0.5)
        print("Step 2 done.")
        snap = world.telemetry_snapshot()
        print("Snapshot successful! SIM_T:", snap["sim_t"])
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test()
