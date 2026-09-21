#!/usr/bin/env python3
"""Generate data/wordlist.txt: an original 1296-word passphrase list.

The server (CScore::GeneratePassphrase in src/game/server/score.cpp) builds
3-word passphrases from this file and refuses to start with fewer than 1000
words, so the list must stay large. Every word below was authored for Neon
Relay: plain lowercase ASCII, no spaces, at most 31 characters, neutral and
passphrase-friendly.

Format (read by score.cpp ``sscanf(pLine, "%*s %31s", ...)`` and by
scripts/wordlist.py ``line.split("\\t")[1]``): ``<id>\\t<word>`` per line,
ids run 1111..6666 in base-6 diceware order.

Stdlib only.
"""

from __future__ import annotations

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "wordlist.txt"

# Twenty-one themed banks, authored for this project. Counts per bank:
# 65 + 60 + 65 + 60 + 70 + 75 + 60 + 60 + 55 + 50 + 60 + 55 + 60 + 55
# + 50 + 50 + 55 + 55 + 50 + 55 + 131 = 1296.
SKY = """dawn dusk aurora breeze gust storm thunder rain rainbow cloud fog
mist frost snow hail sleet drizzle shower tempest cyclone monsoon drought
vapor dew puddle ripple wave tide current stream river brook creek pond lake
lagoon ocean sea bay cove reef shore beach dune desert oasis mirage horizon
summit peak ridge valley canyon gorge cliff bluff mesa plateau plain meadow
prairie tundra glacier iceberg avalanche"""

SPACE = """nova pulsar quasar nebula galaxy comet meteor asteroid orbit eclipse
solstice equinox cosmos void vacuum plasma ion photon quantum gravity pixel
voxel circuit diode laser radar beacon signal static frequency wavelength
amplitude resonance echo halo corona flare spark flash flicker shimmer glimmer
gleam glow blaze rocket capsule module probe rover lander station satellite
telescope observatory planet moon lunar solar stellar"""

CITY = """avenue boulevard street lane alley plaza square tower spire bridge
tunnel arch gate door window roof chimney balcony porch patio garage shed barn
silo depot terminal harbor port dock pier wharf market bazaar mall arcade
cinema theater museum library school campus clinic hotel motel cafe bakery
diner bistro kiosk booth stall stand crosswalk sidewalk curb hydrant lamppost
fountain statue monument memorial chapel temple shrine embassy"""

HOME = """chair table lamp candle mirror frame shelf drawer cabinet closet rug
carpet curtain blind pillow blanket sheet towel soap sponge bucket broom mop
brush comb clip pin needle thread button zipper pocket wallet purse key lock
knob handle hinge latch bolt nail screw hammer wrench pliers saw drill level
ruler tongs ladle whisk spatula kettle teapot mug cup saucer plate"""

FOOD = """apple pear peach plum cherry berry grape melon lemon lime mango papaya
kiwi fig date olive almond walnut peanut cashew pecan hazelnut chestnut bread
toast bagel muffin scone biscuit cookie cake pie tart pudding custard cream
butter cheese yogurt milk honey syrup jam jelly sugar salt pepper spice herb
basil mint thyme oregano parsley dill garlic onion carrot potato tomato celery
lettuce spinach kale cabbage bean pea lentil rice oats"""

ANIMALS = """fox wolf bear deer elk moose bison rabbit hare squirrel chipmunk
beaver otter badger weasel ferret mole mouse rat bat owl hawk eagle falcon
crow raven sparrow finch robin wren lark dove pigeon duck goose swan heron
crane stork pelican gull tern shark whale dolphin seal walrus turtle frog toad
lizard gecko snake spider ant bee wasp hornet butterfly moth beetle cricket
snail crab lobster shrimp clam oyster coral salmon trout bass perch minnow
eel"""

MUSIC = """melody harmony rhythm beat tempo tune song hymn anthem ballad chorus
verse riff solo duet trio quartet choir band orchestra piano guitar violin
cello flute trumpet drum cymbal octave chord scale note major minor sharp flat
acoustic electric treble alto soprano tenor vocal lyric encore overture
interlude prelude finale rehearsal concert gig medley remix sample loop track
album single vinyl"""

SPORT = """sprint dash jog hike climb jump leap hop skip dive swim float glide
slide skate ski surf sail row paddle pedal kick throw catch toss roll spin
twirl flip vault hurdle race chase relay lap course pitch field court rink
pool gym arena stadium medal trophy ribbon badge whistle timer score goal
point match bout heat derby marathon triathlon qualifier"""

TECH = """vector raster shader texture sprite tile map grid node edge graph tree
stack queue cache buffer packet pipeline router switch hub modem server
client host peer cluster mesh lattice chip wafer transistor capacitor kernel
script console daemon process fiber socket firewall proxy gateway protocol
codec cipher hash token nonce checksum binary octal decimal hexadecimal
viewport"""

COLOR = """crimson scarlet ruby amber gold bronze copper jade emerald teal cyan
azure cobalt indigo violet magenta rose blush mauve ivory ebony onyx slate ash
smoke chrome pastel vivid bright dim pale dark light neon infrared ultraviolet
sepia ochre umber sienna beige taupe charcoal graphite silver pewter platinum
titanium prism spectrum"""

PLANTS = """oak pine maple birch cedar elm willow poplar palm fern moss lichen
clover daisy tulip lily orchid iris poppy sunflower dandelion thistle reed
bamboo cactus succulent vine ivy hedge shrub bush grove forest jungle timber
log stump branch twig leaf petal stem root seed bloom blossom bouquet garden
orchard park trail path sapling seedling pollen nectar bark trunk canopy
undergrowth"""

MATERIALS = """diamond sapphire topaz opal quartz crystal marble granite basalt
flint chalk clay sand gravel pebble stone rock boulder gem jewel pearl shell
glass ceramic porcelain paper canvas linen cotton silk wool leather denim
velvet satin felt lace fringe tassel patch quilt tapestry mosaic fresco mural
relief bust totem idol relic artifact heirloom keepsake trinket"""

VERBS = """build craft forge shape carve mold paint draw sketch write read sing
dance play laugh smile dream wish hope trust brave dare venture wander roam
explore discover invent create design assemble polish refine sharpen strengthen
anchor tether launch ignite kindle stoke fuel charge power boost accelerate
brake steer navigate pilot captain voyage embark disembark arrive depart
return revisit linger ponder wonder"""

ADJECTIVES = """swift nimble calm quiet still serene gentle kind bold keen smooth
soft fresh clear pure clean neat tidy minimal simple honest loyal noble proud
humble wise clever witty funny merry jolly happy glad lucky eager earnest
candid frank lively spry brisk agile sturdy robust staunch steadfast constant
true just fair boxy crisp snappy zesty cozy"""

TRAVEL = """journey trek safari cruise flight ride drive commute transit transfer
arrival departure concourse platform jetty passport ticket voucher coupon
souvenir postcard letter parcel package cargo freight luggage baggage backpack
satchel case suitcase chest crate barrel cask hamper basket tote duffel rucksack
valise carryall compass sextant atlas chart itinerary manifest logbook"""

TIME = """second minute hour morning noon evening night midnight today tomorrow
season spring summer autumn winter month year decade century era age epoch
moment instant holiday festival carnival parade feast gala jubilee occasion
milestone deadline curfew reveille taps vespers matins siesta sabbath advent
recess intermission interval epilogue prologue chapter stanza canto couplet"""

MYTHIC = """dragon phoenix griffin unicorn pegasus fairy pixie gnome elf dwarf
giant titan golem sphinx minotaur hydra kraken yeti mage wizard knight ranger
bard cleric monk scout aviator admiral corsair buccaneer privateer navigator
cartographer astronomer alchemist apothecary herbalist blacksmith wright mason
thatcher cooper weaver potter glassblower chandler cobbler farrier miller
brewer vintner barista chef baker butcher"""

SCIENCE = """atom molecule cell tissue fossil theory axiom theorem proof logic
reason cause effect factor element compound mixture solution solvent carbon
oxygen hydrogen helium argon nickel zinc tin lead iron steel alloy amalgam
catalyst reagent beaker flask vial pipette crucible mortar pestle balance
fulcrum lever pulley wedge axle rotor stator gyroscope pendulum metronome
barometer altimeter chronometer"""

SHAPES = """circle ellipse oval sphere cube monolith pyramid cone cylinder torus
spiral helix coil ring sash stripe dot dotted cross crescent arrow chevron
lozenge hexagon octagon polygon fractal tessellation symmetry emblem crest
sigil glyph rune icon logo brand stamp signet hallmark watermark masthead
colophon imprint engraving etching stencil template matrix"""

ABSTRACT = """unity peace accord focus clarity vision faith honor valor merit
virtue wisdom courage patience grace charm elegance style flair spirit soul
heart mind thought idea notion plan quest mission task aim target purpose
destiny fortune luck serendipity kismet karma mantra motto slogan proverb
adage maxim aphorism parable fable legend myth saga epic ode elegy eulogy"""

SPARE = """lightning downpour cloudburst sunbeam moonbeam starlight sunlight
daylight twilight daybreak nightfall bicycle tricycle unicycle scooter
skateboard wagon cart carriage sleigh sled toboggan canoe kayak raft dinghy
yacht schooner frigate galleon caravel tugboat ferry hovercraft airship blimp
glider helicopter seaplane jetliner streetcar tram trolley monorail subway
locomotive caboose boxcar anvil vise clamp staple rivet washer bearing piston
sparkplug carburetor alternator muffler tailpipe bumper fender hubcap trowel
hoe rake shovel spade shears pruner sprinkler hose nozzle wheelbarrow compost
mulch topsoil loam peat trellis arbor gazebo pergola deck veranda sunroom
mudroom pantry cellar attic dormer skylight burlap muslin flannel twill
jersey stitch seam hem ruffle pleat dart damask chintz gingham calico paisley
herringbone houndstooth pinstripe seersucker taffeta organza chiffon tulle
batiste percale sateen chenille mohair cashmere angora merino worsted
gabardine chino khaki whipcord moleskin"""

BANKS = [SKY, SPACE, CITY, HOME, FOOD, ANIMALS, MUSIC, SPORT, TECH, COLOR,
         PLANTS, MATERIALS, VERBS, ADJECTIVES, TRAVEL, TIME, MYTHIC, SCIENCE,
         SHAPES, ABSTRACT, SPARE]


def words() -> list[str]:
    out: list[str] = []
    for bank in BANKS:
        out.extend(bank.split())
    return out


def diceware_ids(n: int) -> list[str]:
    ids = [f"{a}{b}{c}{d}" for a in "123456" for b in "123456"
           for c in "123456" for d in "123456"]
    assert len(ids) == 1296
    return ids[:n]


def main() -> int:
    all_words = words()
    assert len(all_words) == 1296, f"want 1296 words, have {len(all_words)}"
    assert len(set(all_words)) == len(all_words), "duplicate words present"
    for w in all_words:
        assert w.isascii() and w.islower(), f"bad word: {w!r}"
        assert len(w) <= 31, f"too long: {w!r}"
    lines = [f"{i}\t{w}\n" for i, w in zip(diceware_ids(len(all_words)), all_words)]
    OUT.write_text("".join(lines), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {len(lines)} words")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
