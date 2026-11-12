TERRA NOTA
Your own private map of everywhere you've been and lived.
Everything stays on this Mac. The app never touches the internet.


OPENING IT
  Double-click "Terra Nota.app" in this folder, or press Cmd-Space and type
  Terra Nota. The app itself lives in ~/Applications. To keep it handy, open
  it and choose Options > Keep in Dock from its Dock icon.


USING IT
  Click a country          Flies to it and opens its page: Been and Lived
                           buttons, notes, and its states to tick off.
  Click a state            Opens a card with Been and Lived for that state.
  B or L                   Same as those buttons, for the open card or country.
  Sidebar                  Open a continent to tick places off from a list.
  Cmd-F or /               Search countries and states ("bavar" finds Bavaria).
  Cmd-Z                    Undo. Shift-Cmd-Z redoes.
  Esc                      Close the card, then go back to the world.
  Drag, scroll or arrows   Moves the map. Left and right never run out: the
                           world turns, so the Pacific can sit in the middle.
  Pinch, or + and -        Zooms. The globe button goes back to the whole world.

  Marking a state marks its country as Been too (Lived, if you lived in the
  state), and the country stays marked if you later unmark the state. On the
  world map a marked country is in full colour; open it to see which states.


THE MAP
  The projection is Equal Earth, so every country is drawn at its true size
  relative to the others: Greenland is smaller than Africa, as it should be.
  Big lakes (the Great Lakes, Victoria, Baikal, Great Bear and so on) are
  water. Smaller ones, like Lake Champlain, are drawn as land.

  A name sits inside its country or state when it fits. When it doesn't, it
  moves out to open water (or into a neighbouring country) with a thin line
  back to a dot on the place, once the map stops moving. A state walled in
  by its neighbours, such as Berlin, gets a dot with its name beside it, the
  way a map names a city. Zoom in and more names fit inside.


YOUR DATA
  ~/Library/Application Support/Terra Nota/travels.json
      Everything you've marked. Plain, readable JSON. "Show file" in the
      sidebar opens it. It sits outside the app, so rebuilding or replacing
      the app never touches it.

  ~/Library/Application Support/Terra Nota/Backups/
      A dated copy each day, taken when you open the app or before your first
      change that day, whichever comes first. The newest 30 are kept.

  Export and Import in the sidebar save and restore a backup anywhere you like.
  Import replaces what's on the map, and Cmd-Z takes it back.


HOW THINGS ARE COUNTED
  197 countries: the 193 UN members, plus Vatican City, Palestine, Kosovo and
  Taiwan. Lists differ, and this one is a judgement call.

  45 territories, such as Greenland, Puerto Rico and Hong Kong, can be marked
  and appear on the map but don't count toward the 197. Somaliland, Northern
  Cyprus and Western Sahara are in this group. So is Antarctica, which does
  count toward your 7 continents.

  Borders follow Natural Earth, which draws what's in practice on the ground,
  with one exception: Crimea is shown as part of Ukraine, in line with the UN
  General Assembly.

  "Earth's land" adds up the whole area of every country you've marked, even
  if you've only seen one state of it.

  Countries under 3,000 sq km have no state breakdown. Some others use larger
  units than their official smallest one, so the lists stay tickable: the UK
  is its 4 nations, and France, Italy and Spain are their regions. Natural
  Earth's data can lag behind recent reorganisations (Norway's counties are the
  older set, for example).

  To change any of this, edit the lists at the top of tools/build_map.py.


REBUILDING
  ./build.sh             Rebuilds and reinstalls the app. Needs Apple's command
                         line tools, which are already on this Mac.

  To regenerate the map, download these two files into a folder, then run:
      ne_10m_admin_0_countries_lakes.geojson
      ne_10m_admin_1_states_provinces_lakes.geojson
      from github.com/nvkelso/natural-earth-vector (geojson folder)
  These are the versions with big lakes cut out, so the Great Lakes, Victoria
  and Baikal are water and Michigan has its real shape.

      python3 tools/build_map.py <that folder> web/data
      ./build.sh


SHARING
  ./share.sh             Makes "Terra Nota.zip" on your Desktop to send to
                         friends. It runs on Apple Silicon and Intel Macs
                         (macOS 12 or later), with a "Read me first" note
                         inside. Your travels aren't in it, and the app in
                         ~/Applications isn't touched.

  Because the app isn't registered with Apple, macOS warns your friends the
  first time they open it. The note inside the zip tells them how to get past
  that (right-click > Open, or Privacy & Security > Open Anyway on macOS 15).


WHAT'S IN THIS FOLDER
  web/       The app: map, sidebar and map data.
  native/    The Mac window around it, and the icon.
  tools/     The script that compiles the map.
  build/     Build leftovers. Safe to delete.
  vercel.json  Tells Vercel the website is the web/ folder, so the page finds
             its style sheet, script and map data. Without it the site loads
             as bare, unstyled text with no map.


Map data: Natural Earth (naturalearthdata.com), public domain.
