class_name NeonRelayClient
extends Node
## Godot 4 client boundary for Neon Relay.
##
## The game never sends a private key to this node. WalletAdapter owns wallet
## deep links/signatures; SessionKeyAdapter owns an expiring, scoped session
## key. The race server remains authoritative for movement, checkpoints,
## finish order and reward eligibility.

signal wallet_changed(public_key: String)
signal authenticated(session_token: String)
signal race_event(event: Dictionary)
signal request_failed(code: String, message: String)

@export var backend_url := "http://127.0.0.1:8787"
@export var game_id := "neonrelay"

var wallet_adapter: WalletAdapter
var session_keys: SessionKeyAdapter
var solana_client: SolanaClient
var anchor_program: AnchorProgram
var session_token := ""

func _ready() -> void:
    wallet_adapter = WalletAdapter.new()
    session_keys = SessionKeyAdapter.new()
    solana_client = SolanaClient.new(self, backend_url)
    anchor_program = AnchorProgram.new(solana_client)

## Phantom OAuth, MWA deep links, FirstStep guest and Privy embedded wallets
## implement this same interface. The adapter may open a platform UI, but it
## must return only a public key and a signed challenge to the game.
func connect_wallet(provider: String = "mwa") -> void:
    if wallet_adapter == null:
        wallet_adapter = WalletAdapter.new()
    wallet_adapter.connect(provider, func(public_key: String) -> void:
        wallet_changed.emit(public_key)
        _authenticate(public_key)
    )

func use_guest_identity() -> void:
    wallet_adapter.connect("firststep-guest", func(public_key: String) -> void:
        wallet_changed.emit(public_key)
        _authenticate(public_key)
    )

func _authenticate(public_key: String) -> void:
    var challenge := await solana_client.get_json("/v1/auth/challenge", {})
    if not challenge.ok:
        request_failed.emit(challenge.code, challenge.message)
        return
    var signed := await wallet_adapter.sign_message(challenge.data.challenge)
    if not signed.ok:
        request_failed.emit(signed.code, signed.message)
        return
    var verified := await solana_client.post_json("/v1/auth/verify-wallet", {
        "challenge": challenge.data.challenge,
        "signature": signed.signature,
        "public_key": public_key,
    })
    if not verified.ok:
        request_failed.emit(verified.code, verified.message)
        return
    session_token = verified.data.session_token
    authenticated.emit(session_token)

## Session keys are scoped to move/boost/finish/race_session and expire. A
## production provider can back this object with CgInv/SessKeys. The UI never
## asks for a wallet approval per tick; only the initial scope approval is UX.
func start_race(track_id: String, mode: String) -> Dictionary:
    return await _race_action("start_race", {"track_id": track_id, "mode": mode})

func move(input_vector: Vector2, client_tick: int) -> Dictionary:
    return await _race_action("move", {
        "x": input_vector.x, "y": input_vector.y, "client_tick": client_tick,
    })

func boost(client_tick: int) -> Dictionary:
    return await _race_action("boost", {"client_tick": client_tick})

func finish(checkpoint: int, client_tick: int) -> Dictionary:
    return await _race_action("finish", {
        "checkpoint": checkpoint, "client_tick": client_tick,
    })

func _race_action(action: String, payload: Dictionary) -> Dictionary:
    if session_token.is_empty():
        request_failed.emit("not-authenticated", "connect a wallet or guest identity first")
        return {"ok": false, "code": "not-authenticated"}
    var key := await session_keys.ensure_scope(["move", "boost", "finish", "race_session"])
    if not key.ok:
        request_failed.emit(key.code, key.message)
        return {"ok": false, "code": key.code}
    # This is a relative/authoritative game API in production. The browser or
    # client never calls localhost for another service; set backend_url from
    # the deployment config or proxy this endpoint through the game server.
    var response := await solana_client.post_json("/v3/race/action", {
        "game_id": game_id,
        "action": action,
        "payload": payload,
        "session_key": key.public_scope,
        "session_token": session_token,
    })
    if response.ok:
        race_event.emit(response.data)
    else:
        request_failed.emit(response.code, response.message)
    return response.data if response.ok else {"ok": false, "code": response.code}

## Read-only asset/stats paths. Writes such as cNFT minting and rare NFT
## updates belong to an operator-controlled service, never to a race client.
func read_inventory(owner: String) -> Dictionary:
    return await solana_client.get_json("/api/sdk/core-attributes?gameId=" + game_id + "&owner=" + owner, {})

func read_watchtower_config() -> Dictionary:
    return await solana_client.get_json("/api/os/config", {})


class SolanaClient extends RefCounted:
    var owner: Node
    var base_url: String

    func _init(parent: Node, url: String) -> void:
        owner = parent
        base_url = url.trim_suffix("/")

    func get_json(path: String, _unused: Dictionary = {}) -> Dictionary:
        return await _request(HTTPClient.METHOD_GET, path, {})

    func post_json(path: String, payload: Dictionary) -> Dictionary:
        return await _request(HTTPClient.METHOD_POST, path, payload)

    func _request(method: int, path: String, payload: Dictionary) -> Dictionary:
        var request := HTTPRequest.new()
        owner.add_child(request)
        var headers := PackedStringArray(["Content-Type: application/json"])
        var body := JSON.stringify(payload)
        var error := request.request(base_url + path, headers, method, body)
        if error != OK:
            request.queue_free()
            return {"ok": false, "code": "transport", "message": error_string(error)}
        var result = await request.request_completed
        request.queue_free()
        var response_code: int = result[1]
        var parsed = JSON.parse_string((result[3] as PackedByteArray).get_string_from_utf8())
        if response_code < 200 or response_code >= 300:
            var error_code := "http-%d" % response_code
            var message := "request failed"
            if parsed is Dictionary and parsed.has("error"):
                error_code = str(parsed.error.get("code", error_code))
                message = str(parsed.error.get("message", message))
            return {"ok": false, "code": error_code, "message": message}
        return {"ok": true, "data": parsed}


class WalletAdapter extends RefCounted:
    ## Replace the internals with the platform wallet SDK. Never store a seed
    ## phrase, OAuth access token or private key in this object.
    var public_key := ""

    func connect(_provider: String, callback: Callable) -> void:
        # Integration point for Phantom OAuth, MWA, FirstStep or Privy.
        # A guest adapter can return a public guest key until upgrade/link.
        callback.call(public_key)

    func sign_message(_message_base64url: String) -> Dictionary:
        return {"ok": false, "code": "wallet-adapter-not-installed", "message": "install a wallet adapter"}


class SessionKeyAdapter extends RefCounted:
    var public_scope := ""

    func ensure_scope(_actions: Array[String]) -> Dictionary:
        if public_scope.is_empty():
            return {"ok": false, "code": "session-key-provider-not-installed", "message": "install CgInv/SessKeys adapter"}
        return {"ok": true, "public_scope": public_scope}


class AnchorProgram extends RefCounted:
    var client: SolanaClient

    func _init(solana_client: SolanaClient) -> void:
        client = solana_client

    ## Instruction builders are deliberately read-only placeholders until the
    ## deployment supplies an IDL and program ids. They return a description,
    ## never a fake transaction or a fake signature.
    func build_reward_claim(epoch_id: int, leaf_index: int, proof: Array) -> Dictionary:
        return {
            "program": "NEONRELAY_REWARDS_PROGRAM_ID",
            "instruction": "claim",
            "epoch_id": epoch_id,
            "leaf_index": leaf_index,
            "proof": proof,
            "requires_wallet_signature": true,
        }
