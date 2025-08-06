import readline from "readline";
import { stdin as input, stdout as output } from "process";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getMint,
  getAccount,
  closeAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import chalk from "chalk";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = "https://rpc-proxy.solslugs.workers.dev/";
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT || "5");
const DEFAULT_DEV_WALLET = process.env.DEFAULT_DEV_WALLET;

const connection = new Connection(RPC_URL, "confirmed");
const rl = readline.createInterface({ input, output });

const ask = (q) => new Promise((res) => rl.question(q, res));
const sol = (lamports) => lamports / LAMPORTS_PER_SOL;

async function getMintAuthorityAndName(mintAddress) {
  try {
    const mint = await getMint(connection, new PublicKey(mintAddress));
    return {
      authority: mint.mintAuthority?.toBase58() || null,
      name: "Unknown",
    };
  } catch {
    return { authority: null, name: "Unknown" };
  }
}

(async () => {
  console.log(
    chalk.cyan(`\n\ud83d\udd25 Sol Incinerator CLI [Estimator + Burner]`)
  );
  const inputKey = await ask(
    "\ud83d\udd10 Paste your private key (Base58):\n> "
  );
  let payer;

  try {
    const decoded = bs58.decode(inputKey.trim());
    payer = Keypair.fromSecretKey(decoded);
  } catch (e) {
    console.error(chalk.red("\u274c Invalid Base58 private key."));
    rl.close();
    process.exit(1);
  }

  const owner = payer.publicKey;
  console.log(
    chalk.green(`\n\ud83d\udd0d Scanning wallet: ${owner.toBase58()}`)
  );

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });

  const burnCandidates = [];
  let totalFee = 0;
  let totalReclaim = 0;

  for (const { pubkey, account } of tokenAccounts.value) {
    const info = account.data.parsed.info;
    const amount = parseInt(info.tokenAmount.amount);
    if (amount > 0) continue;

    const accountInfo = await connection.getAccountInfo(pubkey);
    const lamports = accountInfo?.lamports || 0;
    if (lamports === 0) continue;

    const mint = info.mint;
    const { authority, name } = await getMintAuthorityAndName(mint);
    const fee = Math.floor((lamports * FEE_PERCENT) / 100);
    const reclaim = lamports - fee;

    const dev = DEFAULT_DEV_WALLET || owner.toBase58();

    burnCandidates.push({
      ata: pubkey,
      mint,
      name,
      rent: sol(lamports),
      fee: sol(fee),
      reclaim: sol(reclaim),
      dev,
    });

    totalFee += fee;
    totalReclaim += reclaim;
  }

  if (burnCandidates.length === 0) {
    console.log(
      chalk.yellow(
        "\u26a0\ufe0f  No empty token accounts found with reclaimable rent."
      )
    );
    rl.close();
    process.exit(0);
  }

  console.log(
    chalk.yellow(
      `\n\ud83d\udd25 Found ${burnCandidates.length} reclaimable accounts:\n`
    )
  );

  burnCandidates.forEach((c, i) => {
    console.log(`${i + 1}. ${chalk.cyan(c.name)} (${c.mint})`);
    console.log(`   ATA:    ${c.ata.toBase58()}`);
    console.log(`   Rent:   ${c.rent.toFixed(6)} SOL`);
    console.log(`   Fee:    ${c.fee.toFixed(6)} SOL`);
    console.log(`   Dev:    ${c.dev}`);
    console.log(`   Reclaim:${c.reclaim.toFixed(6)} SOL\n`);
  });

  console.log(chalk.green.bold(`\n=== SUMMARY ===`));
  console.log(chalk.green(`Reclaimable: ${sol(totalReclaim).toFixed(6)} SOL`));
  console.log(chalk.cyan(`Dev Fee:     ${sol(totalFee).toFixed(6)} SOL`));
  console.log(chalk.gray(`FEE %:       ${FEE_PERCENT}%`));

  const confirm = await ask(
    "\n\u26a0\ufe0f  Proceed with burn and reclaim? (yes/no): "
  );
  if (!["y", "yes"].includes(confirm.trim().toLowerCase())) {
    console.log(chalk.red("\u274c Aborted by user."));
    rl.close();
    process.exit(0);
  }

  console.log(chalk.blue("\n\ud83d\ude80 Executing burn transactions...\n"));
  rl.close();

  for (const c of burnCandidates) {
    const tx = new Transaction();

    try {
      tx.add(
        closeAccount(
          connection,
          payer,
          c.ata,
          new PublicKey(c.dev),
          payer.publicKey,
          TOKEN_PROGRAM_ID
        )
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
      console.log(chalk.green(`\u2705 Burned ${c.name} | TX: ${sig}`));
    } catch (e) {
      console.error(
        chalk.red(`\u274c Failed to burn ${c.name} | ${e.message}`)
      );
    }
  }

  console.log(
    chalk.green("\n\ud83c\udf89 Done. All eligible accounts processed.\n")
  );
})();
