# GIF for the BTW side-questions PR

Referenced from the description of siteboon/claudecodeui#1673, "feat(chat):
BTW side questions while a session is busy, and a send menu instead of a
one-tap Stop" (from buttjer:feat/btw-side-questions).

`btw-side-question.gif` shows both cases of the send menu, in one session:
a side question while a turn is being written (the menu ends in Stop), then
the turn ends with its tests left running in the background and a second
one is asked (the menu ends in Send anyway). It comes from `make-gif.mts`:

    npx vite build                     # in the claudecodeui checkout
    node make-gif.mts <checkout> btw-side-question.gif

It needs ffmpeg, and playwright-core with a Chromium (`PLAYWRIGHT_FROM=<dir>`
when the checkout has none). It runs a throwaway server with its own HOME and
a seeded demo session; the busy states and the answers are simulated in the
browser. It records whatever `dist/index.html` serves, so build from a clean
checkout.

Keep this branch until that pull request is closed; the description links
to the GIF. The earlier GIF and screenshots are in this branch's history.
