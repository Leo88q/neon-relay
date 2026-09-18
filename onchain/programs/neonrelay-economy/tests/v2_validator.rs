//! Opt-in isolated validator test. Ephemeral keys exist only in process memory.
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token::spl_associated_token_account as ata, token::spl_token};
use neonrelay_economy::{accounts, instruction, EconomyConfigV2, PrizeEpochV2};
use solana_client::{rpc_client::RpcClient, rpc_config::RpcSendTransactionConfig};
use solana_sdk::{commitment_config::CommitmentConfig, instruction::Instruction, program_pack::Pack,
    pubkey::Pubkey, signature::{Keypair, Signer}, system_instruction, system_program, transaction::Transaction};
use std::{sync::atomic::{AtomicU32, Ordering}, time::{Duration, Instant}};
fn pda(seeds: &[&[u8]]) -> Pubkey { Pubkey::find_program_address(seeds, &neonrelay_economy::id()).0 }
fn ix(meta: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: neonrelay_economy::id(), accounts: meta.to_account_metas(None), data: data.data() }
}
fn send(rpc: &RpcClient, payer: &Keypair, extra: &[&Keypair], instructions: Vec<Instruction>, ok: bool) {
    static NONCE: AtomicU32 = AtomicU32::new(300_000);
    let mut all = vec![solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(NONCE.fetch_add(1, Ordering::Relaxed))];
    all.extend(instructions);
    let mut signers = vec![payer]; signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(&all, Some(&payer.pubkey()), &signers, rpc.get_latest_blockhash().unwrap());
    let result = rpc.send_and_confirm_transaction_with_spinner_and_config(&tx, CommitmentConfig::confirmed(),
        RpcSendTransactionConfig { skip_preflight: true, ..Default::default() });
    assert_eq!(result.is_ok(), ok, "validator transaction: {result:?}");
}
fn state<T: AccountDeserialize>(rpc: &RpcClient, key: Pubkey) -> T {
    T::try_deserialize(&mut rpc.get_account_data(&key).unwrap().as_slice()).unwrap()
}
fn balance(rpc: &RpcClient, key: Pubkey) -> u64 {
    rpc.get_token_account_balance(&key).unwrap().amount.parse().unwrap()
}
#[test]
#[ignore = "requires isolated local validator loaded with the economy ELF"]
fn rpc_lifecycle() {
    // Deliberately no configurable network URL: impossible to target a cluster.
    assert_eq!(std::env::var("NEONRELAY_LOCAL_VALIDATOR").as_deref(), Ok("1"));
    let rpc = RpcClient::new_with_commitment("http://127.0.0.1:8899".to_owned(), CommitmentConfig::confirmed());
    let admin = Keypair::new(); let player = Keypair::new();
    for key in [admin.pubkey(), player.pubkey()] {
        let sig = rpc.request_airdrop(&key, 10_000_000_000).unwrap();
        let start = Instant::now();
        while !rpc.confirm_transaction(&sig).unwrap() {
            assert!(start.elapsed() < Duration::from_secs(60)); std::thread::sleep(Duration::from_millis(200));
        }
    }
    let mints = [Keypair::new(), Keypair::new()];
    let treasury: Vec<_> = mints.iter().map(|m| ata::get_associated_token_address(&admin.pubkey(), &m.pubkey())).collect();
    let sources: Vec<_> = mints.iter().map(|m| ata::get_associated_token_address(&player.pubkey(), &m.pubkey())).collect();
    for i in 0..2 {
        send(&rpc, &admin, &[&mints[i]], vec![
            system_instruction::create_account(&admin.pubkey(), &mints[i].pubkey(), rpc.get_minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN).unwrap(), spl_token::state::Mint::LEN as u64, &spl_token::id()),
            spl_token::instruction::initialize_mint2(&spl_token::id(), &mints[i].pubkey(), &admin.pubkey(), None, 0).unwrap(),
            ata::instruction::create_associated_token_account(&admin.pubkey(), &admin.pubkey(), &mints[i].pubkey(), &spl_token::id()),
            ata::instruction::create_associated_token_account(&admin.pubkey(), &player.pubkey(), &mints[i].pubkey(), &spl_token::id()),
            spl_token::instruction::mint_to(&spl_token::id(), &mints[i].pubkey(), &sources[i], &admin.pubkey(), &[], 100).unwrap(),
        ], true);
    }
    // Exercise real legacy bootstrap, not a genesis account fixture.
    let legacy = pda(&[b"neonrelay_economy_config"]);
    let old_vault = ata::get_associated_token_address(&legacy, &mints[0].pubkey());
    send(&rpc, &admin, &[], vec![ix(accounts::Initialize { authority: admin.pubkey(), config: legacy,
        mint: mints[0].pubkey(), treasury_ata: treasury[0], vault_ata: old_vault,
        token_program: spl_token::id(), associated_token_program: ata::id(), system_program: system_program::id() },
        instruction::Initialize { rake_bps: 1000, fee_match: 50, fee_tournament: 100 })], true);
    let mut public = vec![];
    for i in 0..2 {
        let mint = mints[i].pubkey();
        let config = pda(&[b"neonrelay_economy_v2", mint.as_ref()]);
        let vault = ata::get_associated_token_address(&config, &mint);
        send(&rpc, &admin, &[], vec![ix(accounts::InitializeV2 { authority: admin.pubkey(), legacy_config: legacy,
            mint, config, treasury_ata: treasury[i], vault_ata: vault, token_program: spl_token::id(),
            associated_token_program: ata::id(), system_program: system_program::id() }, instruction::InitializeV2 { rake_bps: 1000 })], true);
        let reference = [42; 32];
        let ticket = pda(&[b"neonrelay_entry_v2", mint.as_ref(), &reference, player.pubkey().as_ref()]);
        let pay = ix(accounts::PayEntryV2 { player: player.pubkey(), config, player_ata: sources[i], vault_ata: vault,
            treasury_ata: treasury[i], ticket, token_program: spl_token::id(), system_program: system_program::id() },
            instruction::PayEntryV2 { reference, kind: 0, tier: 0 });
        send(&rpc, &player, &[], vec![pay.clone()], true);
        send(&rpc, &player, &[], vec![pay], false);
        assert_eq!((balance(&rpc, sources[i]), balance(&rpc, treasury[i]), balance(&rpc, vault)), (50, 5, 45));
        let prizes = pda(&[b"neonrelay_prizes_v2", mint.as_ref(), &1u64.to_le_bytes()]);
        let root = neonrelay_economy::merkle_leaf_v2(&player.pubkey().to_bytes(), 45, &mint.to_bytes());
        send(&rpc, &admin, &[], vec![ix(accounts::PublishPrizesV2 { authority: admin.pubkey(), config, vault_ata: vault,
            prizes, system_program: system_program::id() }, instruction::PublishPrizesV2 { epoch: 1, root, total: 45, leaf_count: 1 })], true);
        let claim = pda(&[b"neonrelay_claim_v2", mint.as_ref(), &1u64.to_le_bytes(), player.pubkey().as_ref()]);
        let claim_ix = ix(accounts::ClaimPrizeV2 { player: player.pubkey(), config, player_ata: sources[i], vault_ata: vault,
            prizes, claim, token_program: spl_token::id(), system_program: system_program::id() },
            instruction::ClaimPrizeV2 { epoch: 1, amount: 45, leaf_index: 0, proof: vec![] });
        send(&rpc, &player, &[], vec![claim_ix.clone()], true);
        send(&rpc, &player, &[], vec![claim_ix], false);
        assert_eq!((balance(&rpc, sources[i]), balance(&rpc, treasury[i]), balance(&rpc, vault)), (95, 5, 0));
        assert_eq!(state::<EconomyConfigV2>(&rpc, config).reserved, 0);
        assert_eq!(state::<PrizeEpochV2>(&rpc, prizes).remaining, 0);
        public.push(serde_json::json!({"mint": mint.to_string(), "wallet": player.pubkey().to_string(), "reference": "2a".repeat(32)}));
    }
    // Wait for the final observed slot to root before backend finalized reads.
    let slot = rpc.get_slot().unwrap(); let start = Instant::now();
    while rpc.get_slot_with_commitment(CommitmentConfig::finalized()).unwrap() < slot {
        assert!(start.elapsed() < Duration::from_secs(90)); std::thread::sleep(Duration::from_millis(300));
    }
    std::fs::write(std::env::var("NEONRELAY_PUBLIC_FIXTURE").unwrap(), serde_json::to_vec(&public).unwrap()).unwrap();
}
