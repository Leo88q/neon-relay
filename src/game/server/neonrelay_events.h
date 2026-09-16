/* Neon Relay reward-event emission (stage 8). Off unless sv_neonrelay_signing 1. */
#ifndef GAME_SERVER_NEONRELAY_EVENTS_H
#define GAME_SERVER_NEONRELAY_EVENTS_H

class CGameContext;

namespace neonrelay {

/* Called from CScore::SaveScore for every accepted race finish. Appends one
 * signed JSONL event to sv_neonrelay_signing_outfile when signing is enabled.
 * Never blocks gameplay: all failures are logged once and ignored. */
void EmitFinishEvent(CGameContext *pGameServer, int ClientId, int TimeTicks);

} // namespace neonrelay

#endif // GAME_SERVER_NEONRELAY_EVENTS_H
