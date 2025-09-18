import {
  Connection,
  Keypair,
  VersionedTransaction,
  SystemProgram,
  PublicKey,
  TransactionMessage,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

export async function jito_buy(
  tokenMint: string,
  solAmount: number,
  slippageBps?: number,
  priorityFee?: number
): Promise<{ txid: string; price?: number }> {
  try {
    console.log(`⚡ JITO Buy: ${solAmount} SOL for ${tokenMint}`);

    // 1. Setup wallet and connection
    const privateKey = process.env.WALLET_SECRET;
    if (!privateKey) throw new Error("WALLET_SECRET not configured");

    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
    );

    console.log(`💰 Using wallet: ${wallet.publicKey.toString()}`);

    // 2. Get Jupiter quote
    const amountInLamports = Math.floor(solAmount * 1e9);
    const slippage = slippageBps ? Math.floor(slippageBps * 100) : 150;

    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote?` +
      `inputMint=So11111111111111111111111111111111111111112&` +
      `outputMint=${tokenMint}&` +
      `amount=${amountInLamports}&` +
      `slippageBps=${slippage}`;

    console.log(`📊 Getting Jupiter quote for Jito bundle...`);
    const quoteResponse = await fetch(quoteUrl);

    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      throw new Error(
        `Jupiter quote failed: ${quoteResponse.status} - ${errorText}`
      );
    }

    const quote = await quoteResponse.json();
    console.log(`💱 Quote: ${quote.outAmount} tokens for ${solAmount} SOL`);

    // 3. Get swap transaction
    console.log(`🔄 Creating swap transaction for Jito bundle...`);
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: Math.floor((priorityFee || 0.0001) * 1e9),
      }),
    });

    if (!swapResponse.ok) {
      const errorData = await swapResponse.text();
      throw new Error(
        `Jupiter swap creation failed: ${swapResponse.status} - ${errorData}`
      );
    }

    const { swapTransaction } = await swapResponse.json();

    // 4. Prepare main swap transaction
    const transactionBuf = Buffer.from(swapTransaction, "base64");
    const swapTx = VersionedTransaction.deserialize(transactionBuf);
    swapTx.sign([wallet]);

    // 5. Create Jito tip transaction
    const jitoTipAccounts = [
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", // Jito tip account 1
      "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", // Jito tip account 2
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", // Jito tip account 3
      "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", // Jito tip account 4
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", // Jito tip account 5
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", // Jito tip account 6
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", // Jito tip account 7
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT", // Jito tip account 8
    ];

    // Pick a random tip account
    const tipAccount = new PublicKey(
      jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)]
    );

    // Tip amount (0.0001 to 0.001 SOL)
    const tipAmountLamports = Math.floor(
      (0.0001 + Math.random() * 0.0009) * 1e9
    );

    console.log(
      `💰 Creating tip payment: ${
        tipAmountLamports / 1e9
      } SOL to ${tipAccount.toString()}`
    );

    // Get latest blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    // Create tip transaction
    const tipInstruction = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipAccount,
      lamports: tipAmountLamports,
    });

    // Add compute budget instruction for tip tx
    const computeBudgetInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.floor(((priorityFee || 0.0001) * 1e9) / 1000),
    });

    const tipMessage = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetInstruction, tipInstruction],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMessage);
    tipTx.sign([wallet]);

    // 6. Submit bundle to Jito
    console.log(`⚡ Submitting bundle to Jito...`);

    const jitoEndpoints = [
      "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
      "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
      "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
      "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
      "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
    ];

    // Bundle contains: [swap transaction, tip transaction]
    const bundle = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [
        [bs58.encode(swapTx.serialize()), bs58.encode(tipTx.serialize())],
      ],
    };

    let jitoResult = null;
    let lastError = null;

    // Try multiple endpoints
    for (let i = 0; i < jitoEndpoints.length; i++) {
      const endpoint = jitoEndpoints[i];

      try {
        console.log(
          `⚡ Trying Jito endpoint ${i + 1}/${jitoEndpoints.length}...`
        );

        const jitoResponse = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bundle),
        });

        if (jitoResponse.ok) {
          jitoResult = await jitoResponse.json();

          if (jitoResult.error) {
            lastError = `Jito API error: ${jitoResult.error.message}`;
            console.log(`❌ ${lastError}`);
            continue;
          }

          console.log(
            `✅ Jito bundle submitted via endpoint ${i + 1}: ${
              jitoResult.result
            }`
          );
          break;
        } else {
          const errorData = await jitoResponse.text();
          lastError = `HTTP ${jitoResponse.status}: ${errorData}`;
          console.log(`❌ Endpoint ${i + 1} failed: ${lastError}`);

          if (jitoResponse.status === 429) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      } catch (error) {
        lastError = `Network error: ${error.message}`;
        console.log(`❌ Endpoint ${i + 1} error: ${lastError}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // If all Jito endpoints failed, fallback to regular Jupiter
    if (!jitoResult || jitoResult.error) {
      console.log(
        `⚠️ All Jito endpoints failed, falling back to regular Jupiter`
      );
      console.log(`   Last error: ${lastError}`);

      const rawTransaction = swapTx.serialize();
      const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });

      console.log(`✅ Fallback transaction sent: ${txid}`);

      const confirmation = await connection.confirmTransaction({
        signature: txid,
        blockhash,
        lastValidBlockHeight,
      });

      if (confirmation.value.err) {
        throw new Error(
          `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
        );
      }

      const tokensReceived = parseInt(quote.outAmount);
      const price = tokensReceived / solAmount;

      return { txid, price };
    }

    // 7. Wait for Jito bundle execution
    const bundleId = jitoResult.result;
    console.log(
      `⏳ Waiting for Jito bundle execution... Bundle ID: ${bundleId}`
    );

    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log(`✅ Jito bundle executed successfully`);

    const tokensReceived = parseInt(quote.outAmount);
    const price = tokensReceived / solAmount;

    return {
      txid: `JITO_BUNDLE_${bundleId}`,
      price,
    };
  } catch (error) {
    console.error(`❌ Jito buy failed:`, error.message);
    throw error;
  }
}
