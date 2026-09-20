//! Bank/runtime + real SPL CPI tests. NEONRELAY_TEST_SBF=1 requires the built ELF.
//! Default mode is native; neither mode contacts a validator or deploys a program.
use anchor_lang::{prelude::*, AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_lang::solana_program::{entrypoint::ProgramResult, program_pack::Pack};
use anchor_spl::token::spl_token;
use neonrelay_economy::{accounts, instruction, EconomyConfigV2, EntryTicketV2, PrizeEpochV2};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{account::Account, instruction::Instruction, signature::{Keypair, Signer}, transaction::Transaction, system_program};

// Anchor 0.30 ties the slice lifetime to AccountInfo's inner lifetime. The native
// test adapter retains a small cloned slice per invocation (no unsafe casts).
// Only this short-lived test process leaks these slices; never production code.
fn entry<'a, 'b, 'c, 'd>(id: &'a Pubkey, accounts: &'b [AccountInfo<'c>], data: &'d [u8]) -> ProgramResult {
    neonrelay_economy::entry(id, Box::leak(accounts.to_vec().into_boxed_slice()), data)
}
fn economy_test() -> ProgramTest {
    let sbf = std::env::var("NEONRELAY_TEST_SBF").as_deref() == Ok("1");
    if sbf {
        let directory = std::env::var("BPF_OUT_DIR").expect("SBF mode requires BPF_OUT_DIR");
        let elf = std::path::Path::new(&directory).join("neonrelay_economy.so");
        assert!(elf.is_file(), "SBF binary missing: {}", elf.display());
    }
    let mut test = ProgramTest::default();
    test.prefer_bpf(sbf);
    // None in SBF mode prevents a silent native fallback for the economy.
    test.add_program("neonrelay_economy", neonrelay_economy::id(), if sbf { None } else { processor!(entry) });
    // SPL/ATA dependencies retain their actual native processors in both modes.
    test.prefer_bpf(false);
    test
}
fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) { Pubkey::find_program_address(seeds, &neonrelay_economy::id()) }
fn stored(data: Vec<u8>, owner: Pubkey) -> Account {
    Account { lamports: Rent::default().minimum_balance(data.len()), data, owner, executable: false, rent_epoch: 0 }
}
fn token(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let state = spl_token::state::Account { mint, owner, amount,
        state: spl_token::state::AccountState::Initialized, ..Default::default() };
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(state, &mut data).unwrap();
    stored(data, spl_token::id())
}
fn ix(meta: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: neonrelay_economy::id(), accounts: meta.to_account_metas(None), data: data.data() }
}
async fn send(ctx: &mut ProgramTestContext, signer: &Keypair, instruction: Instruction, ok: bool) {
    // Vary the compute budget to avoid cached identical signatures on retries;
    // duplicate tests must really execute the program init constraint.
    static NONCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(200_000);
    let unique = solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(
        NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[unique, instruction], Some(&ctx.payer.pubkey()), &[&ctx.payer, signer], hash);
    let result = ctx.banks_client.process_transaction_with_metadata(tx).await.unwrap();
    assert_eq!(result.result.is_ok(), ok, "unexpected transaction result: {result:?}");
}
async fn balance(ctx: &mut ProgramTestContext, key: Pubkey) -> u64 {
    let account = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    spl_token::state::Account::unpack(&account.data).unwrap().amount
}
async fn state<T: AccountDeserialize>(ctx: &mut ProgramTestContext, key: Pubkey) -> T {
    let account = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[tokio::test]
async fn payment_reservations_claims_and_atomic_failures() {
    let admin = Keypair::new(); let player = Keypair::new();
    let mint = Pubkey::new_unique(); let source = Pubkey::new_unique(); let treasury = Pubkey::new_unique();
    let (config, bump) = pda(&[b"neonrelay_economy_v2", mint.as_ref()]);
    let vault = anchor_spl::associated_token::get_associated_token_address(&config, &mint);
    let mut test = economy_test();
    test.add_program("spl_token", spl_token::id(), processor!(spl_token::processor::Processor::process));
    for key in [admin.pubkey(), player.pubkey()] {
        test.add_account(key, Account { lamports: 10_000_000_000, owner: system_program::id(), ..Default::default() });
    }
    // Bootstrap is deliberately seeded, not claimed as tested initialization.
    let cfg = EconomyConfigV2 { authority: admin.pubkey(), mint, treasury_ata: treasury,
        vault_ata: vault, fees: [50, 100, 500, 2000], rake_bps: 1000, reserved: 0, paused: false, bump };
    let mut data = Vec::new(); cfg.try_serialize(&mut data).unwrap();
    test.add_account(config, stored(data, neonrelay_economy::id()));
    test.add_account(source, token(mint, player.pubkey(), 100));
    test.add_account(treasury, token(mint, admin.pubkey(), 0));
    test.add_account(vault, token(mint, config, 0));
    let mut ctx = test.start_with_context().await;
    let pay = |reference: [u8; 32], tier| {
        let (ticket, _) = pda(&[b"neonrelay_entry_v2", mint.as_ref(), &reference, player.pubkey().as_ref()]);
        (ticket, ix(accounts::PayEntryV2 { player: player.pubkey(), config, player_ata: source,
            vault_ata: vault, treasury_ata: treasury, ticket, token_program: spl_token::id(), system_program: system_program::id() },
            instruction::PayEntryV2 { reference, kind: 0, tier }))
    };
    let (ticket, payment) = pay([4; 32], 0);
    send(&mut ctx, &player, payment.clone(), true).await;
    assert_eq!(balance(&mut ctx, source).await, 50);
    assert_eq!(balance(&mut ctx, treasury).await, 5);
    assert_eq!(balance(&mut ctx, vault).await, 45);
    let paid: EntryTicketV2 = state(&mut ctx, ticket).await;
    assert_eq!((paid.mint, paid.player, paid.amount), (mint, player.pubkey(), 50));
    send(&mut ctx, &player, payment, false).await;
    // Rake CPI can succeed (10 <= 50), then prize CPI fails (90 > 40).
    // Entire transaction, including ticket creation and rake, must roll back.
    let (failed_ticket, too_expensive) = pay([5; 32], 1);
    send(&mut ctx, &player, too_expensive, false).await;
    assert!(ctx.banks_client.get_account(failed_ticket).await.unwrap().is_none());
    assert_eq!(balance(&mut ctx, source).await, 50);
    assert_eq!(balance(&mut ctx, treasury).await, 5);
    assert_eq!(balance(&mut ctx, vault).await, 45);
    let pause = |authority, paused| ix(accounts::AdminV2 { authority, config }, instruction::SetPausedV2 { paused });
    send(&mut ctx, &player, pause(player.pubkey(), true), false).await;
    send(&mut ctx, &admin, pause(admin.pubkey(), true), true).await;
    send(&mut ctx, &player, pay([6; 32], 0).1, false).await;
    send(&mut ctx, &admin, pause(admin.pubkey(), false), true).await;
    let root = neonrelay_economy::merkle_leaf_v2(&player.pubkey().to_bytes(), 45, &mint.to_bytes());
    let publish = |epoch: u64, total| {
        let (prizes, _) = pda(&[b"neonrelay_prizes_v2", mint.as_ref(), &epoch.to_le_bytes()]);
        (prizes, ix(accounts::PublishPrizesV2 { authority: admin.pubkey(), config, vault_ata: vault, prizes, system_program: system_program::id() },
            instruction::PublishPrizesV2 { epoch, root, total, leaf_count: 1 }))
    };
    let (prizes, publication) = publish(1, 45);
    send(&mut ctx, &admin, publication.clone(), true).await;
    send(&mut ctx, &admin, publication, false).await;
    let (excess_epoch, excess) = publish(2, 1);
    send(&mut ctx, &admin, excess, false).await;
    assert!(ctx.banks_client.get_account(excess_epoch).await.unwrap().is_none());
    assert_eq!(state::<EconomyConfigV2>(&mut ctx, config).await.reserved, 45);
    let (claim, _) = pda(&[b"neonrelay_claim_v2", mint.as_ref(), &1u64.to_le_bytes(), player.pubkey().as_ref()]);
    let claim_ix = |amount| ix(accounts::ClaimPrizeV2 { player: player.pubkey(), config, player_ata: source,
        vault_ata: vault, prizes, claim, token_program: spl_token::id(), system_program: system_program::id() },
        instruction::ClaimPrizeV2 { epoch: 1, amount, leaf_index: 0, proof: vec![] });
    send(&mut ctx, &player, claim_ix(44), false).await;
    assert!(ctx.banks_client.get_account(claim).await.unwrap().is_none());
    assert_eq!(state::<EconomyConfigV2>(&mut ctx, config).await.reserved, 45);
    send(&mut ctx, &admin, pause(admin.pubkey(), true), true).await;
    send(&mut ctx, &player, claim_ix(45), false).await;
    send(&mut ctx, &admin, pause(admin.pubkey(), false), true).await;
    send(&mut ctx, &player, claim_ix(45), true).await;
    send(&mut ctx, &player, claim_ix(45), false).await;
    assert_eq!(balance(&mut ctx, source).await, 95);
    assert_eq!(balance(&mut ctx, vault).await, 0);
    assert_eq!(balance(&mut ctx, treasury).await, 5);
    assert_eq!(state::<EconomyConfigV2>(&mut ctx, config).await.reserved, 0);
    assert_eq!(state::<PrizeEpochV2>(&mut ctx, prizes).await.remaining, 0);
}

#[tokio::test]
async fn initialize_and_isolate_two_mint_markets() {
    use neonrelay_economy::EconomyConfig;
    use anchor_spl::associated_token::{self, spl_associated_token_account};
    let admin = Keypair::new(); let player = Keypair::new();
    let (legacy, legacy_bump) = pda(&[b"neonrelay_economy_config"]);
    let mints = [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()];
    let treasuries = [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()];
    let sources = [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()];
    let configs = mints.map(|mint| pda(&[b"neonrelay_economy_v2", mint.as_ref()]).0);
    let vaults: Vec<_> = (0..3).map(|i| associated_token::get_associated_token_address(&configs[i], &mints[i])).collect();
    let mut test = economy_test();
    test.add_program("spl_token", spl_token::id(), processor!(spl_token::processor::Processor::process));
    test.add_program("spl_associated_token_account", associated_token::ID,
        processor!(spl_associated_token_account::processor::process_instruction));
    for key in [admin.pubkey(), player.pubkey()] {
        test.add_account(key, Account { lamports: 10_000_000_000, owner: system_program::id(), ..Default::default() });
    }
    // Only legacy operator bootstrap and initialized mint/source/treasury state
    // are seeded. All v2 config, vault, ticket, epoch and claim accounts are real
    // instruction-created accounts, including ATA/System/SPL CPI initialization.
    let old = EconomyConfig { authority: admin.pubkey(), mint: mints[0], treasury_ata: treasuries[0],
        vault_ata: Pubkey::new_unique(), rake_bps: 1000, fee_match: 50, fee_tournament: 100,
        paused: false, bump: legacy_bump, reserved: 0, pending_authority: Pubkey::default(), authority_change_slot: 0 };
    let mut data = Vec::new(); old.try_serialize(&mut data).unwrap();
    test.add_account(legacy, stored(data, neonrelay_economy::id()));
    for (i, decimals) in [0, 6, 16].into_iter().enumerate() {
        let mint_state = spl_token::state::Mint { decimals, is_initialized: true, supply: 100_000_000,
            ..Default::default() };
        let mut data = vec![0; spl_token::state::Mint::LEN];
        spl_token::state::Mint::pack(mint_state, &mut data).unwrap();
        test.add_account(mints[i], stored(data, spl_token::id()));
        test.add_account(treasuries[i], token(mints[i], admin.pubkey(), 0));
        test.add_account(sources[i], token(mints[i], player.pubkey(), 100_000_000));
    }
    let mut ctx = test.start_with_context().await;
    let initialize = |i: usize, authority, treasury_ata, rake_bps| ix(accounts::InitializeV2 {
        authority, legacy_config: legacy, mint: mints[i], config: configs[i], treasury_ata,
        vault_ata: vaults[i], token_program: spl_token::id(), associated_token_program: associated_token::ID,
        system_program: system_program::id() }, instruction::InitializeV2 { rake_bps });
    send(&mut ctx, &player, initialize(0, player.pubkey(), treasuries[0], 1000), false).await;
    send(&mut ctx, &admin, initialize(0, admin.pubkey(), treasuries[1], 1000), false).await;
    // Correct mint but treasury owned by the player must also fail.
    send(&mut ctx, &admin, initialize(0, admin.pubkey(), sources[0], 1000), false).await;
    send(&mut ctx, &admin, initialize(0, admin.pubkey(), treasuries[0], 2001), false).await;
    send(&mut ctx, &admin, initialize(2, admin.pubkey(), treasuries[2], 1000), false).await;
    for i in [0, 2] {
        assert!(ctx.banks_client.get_account(configs[i]).await.unwrap().is_none());
        assert!(ctx.banks_client.get_account(vaults[i]).await.unwrap().is_none());
    }
    for i in 0..2 {
        send(&mut ctx, &admin, initialize(i, admin.pubkey(), treasuries[i], 1000), true).await;
        send(&mut ctx, &admin, initialize(i, admin.pubkey(), treasuries[i], 1000), false).await;
        let cfg: EconomyConfigV2 = state(&mut ctx, configs[i]).await;
        assert_eq!((cfg.authority, cfg.mint, cfg.vault_ata, cfg.treasury_ata),
            (admin.pubkey(), mints[i], vaults[i], treasuries[i]));
        assert_eq!(cfg.fees, neonrelay_economy::tier_fees_v2(if i == 0 { 0 } else { 6 }).unwrap());
        assert_eq!(cfg.reserved, 0); assert!(!cfg.paused);
        let account = ctx.banks_client.get_account(vaults[i]).await.unwrap().unwrap();
        let vault = spl_token::state::Account::unpack(&account.data).unwrap();
        assert_eq!((vault.mint, vault.owner, vault.amount), (mints[i], configs[i], 0));
    }
    assert_ne!(configs[0], configs[1]); assert_ne!(vaults[0], vaults[1]);
    let reference = [42; 32];
    let tickets = mints.map(|mint| pda(&[b"neonrelay_entry_v2", mint.as_ref(), &reference, player.pubkey().as_ref()]).0);
    let pay = |i: usize, source: usize, vault: usize, treasury: usize, ticket: usize| ix(accounts::PayEntryV2 {
        player: player.pubkey(), config: configs[i], player_ata: sources[source], vault_ata: vaults[vault],
        treasury_ata: treasuries[treasury], ticket: tickets[ticket], token_program: spl_token::id(), system_program: system_program::id() },
        instruction::PayEntryV2 { reference, kind: 1, tier: 0 });
    for args in [(0, 1, 0, 0, 0), (0, 0, 1, 0, 0), (0, 0, 0, 1, 0), (0, 0, 0, 0, 1)] {
        send(&mut ctx, &player, pay(args.0, args.1, args.2, args.3, args.4), false).await;
    }
    for i in 0..2 {
        assert!(ctx.banks_client.get_account(tickets[i]).await.unwrap().is_none());
        assert_eq!(balance(&mut ctx, sources[i]).await, 100_000_000);
        assert_eq!(balance(&mut ctx, vaults[i]).await, 0);
        assert_eq!(balance(&mut ctx, treasuries[i]).await, 0);
        send(&mut ctx, &player, pay(i, i, i, i, i), true).await;
        let paid: EntryTicketV2 = state(&mut ctx, tickets[i]).await;
        assert_eq!(paid.mint, mints[i]); assert_eq!(paid.reference, reference);
    }
    assert_ne!(tickets[0], tickets[1]);
    let totals = [45, 45_000_000];
    let roots: Vec<_> = (0..2).map(|i| neonrelay_economy::merkle_leaf_v2(&player.pubkey().to_bytes(), totals[i], &mints[i].to_bytes())).collect();
    let prizes = mints.map(|mint| pda(&[b"neonrelay_prizes_v2", mint.as_ref(), &1u64.to_le_bytes()]).0);
    let claims = mints.map(|mint| pda(&[b"neonrelay_claim_v2", mint.as_ref(), &1u64.to_le_bytes(), player.pubkey().as_ref()]).0);
    for i in 0..2 {
        let publish = ix(accounts::PublishPrizesV2 { authority: admin.pubkey(), config: configs[i],
            vault_ata: vaults[i], prizes: prizes[i], system_program: system_program::id() },
            instruction::PublishPrizesV2 { epoch: 1, root: roots[i], total: totals[i], leaf_count: 1 });
        send(&mut ctx, &admin, publish, true).await;
    }
    let claim = |i: usize, vault: usize, epoch: usize, claim: usize| ix(accounts::ClaimPrizeV2 {
        player: player.pubkey(), config: configs[i], player_ata: sources[i], vault_ata: vaults[vault],
        prizes: prizes[epoch], claim: claims[claim], token_program: spl_token::id(), system_program: system_program::id() },
        instruction::ClaimPrizeV2 { epoch: 1, amount: totals[i], leaf_index: 0, proof: vec![] });
    for args in [(0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)] {
        send(&mut ctx, &player, claim(args.0, args.1, args.2, args.3), false).await;
    }
    for i in 0..2 {
        assert!(ctx.banks_client.get_account(claims[i]).await.unwrap().is_none());
        assert_eq!(state::<EconomyConfigV2>(&mut ctx, configs[i]).await.reserved, totals[i]);
    }
    send(&mut ctx, &player, claim(0, 0, 0, 0), true).await;
    assert_eq!(state::<EconomyConfigV2>(&mut ctx, configs[1]).await.reserved, totals[1]);
    assert_eq!(balance(&mut ctx, vaults[1]).await, totals[1]);
    send(&mut ctx, &player, claim(1, 1, 1, 1), true).await;
    for i in 0..2 {
        send(&mut ctx, &player, claim(i, i, i, i), false).await;
        assert_eq!(state::<EconomyConfigV2>(&mut ctx, configs[i]).await.reserved, 0);
        assert_eq!(state::<PrizeEpochV2>(&mut ctx, prizes[i]).await.remaining, 0);
        assert_eq!(balance(&mut ctx, vaults[i]).await, 0);
        let rake = if i == 0 { 5 } else { 5_000_000 };
        assert_eq!(balance(&mut ctx, treasuries[i]).await, rake);
        assert_eq!(balance(&mut ctx, sources[i]).await, 100_000_000 - rake);
    }
    assert_ne!(prizes[0], prizes[1]); assert_ne!(claims[0], claims[1]);
}
