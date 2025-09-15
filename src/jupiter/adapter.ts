import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export async function jupiter_buy(
  tokenMint: string,
  solAmount: number,
  slippageBps?: number,
  priorityFee?: number
): Promise<{ txid: string; price?: number }> {
  try {
    console.log(`🚀 REAL Jupiter buy: ${solAmount} SOL for ${tokenMint}`);

    // 1. Setup wallet and connection
    const privateKey = process.env.WALLET_SECRET;
    if (!privateKey) throw new Error("WALLET_SECRET not configured");

    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
    );

    console.log(`💰 Using wallet: ${wallet.publicKey.toString()}`);

    // 2. Get Jupiter quote
    const amountInLamports = Math.floor(solAmount * 1e9); // Convert SOL to lamports
    const slippageBps_converted = slippageBps
      ? Math.floor(slippageBps * 100)
      : 150;

    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote?` +
      `inputMint=So11111111111111111111111111111111111111112&` +
      `outputMint=${tokenMint}&` +
      `amount=${amountInLamports}&` +
      `slippageBps=${slippageBps_converted}`;

    console.log("🌐 Jupiter quote URL:", quoteUrl);
    console.log("📊 Request params:");
    console.log("  - Token mint:", tokenMint);
    console.log("  - SOL amount:", solAmount);
    console.log("  - Lamports:", amountInLamports);
    console.log("  - Slippage:", slippageBps_converted);

    console.log(`📊 Getting quote from Jupiter...`);
    const quoteResponse = await fetch(quoteUrl);
    console.log("📥 Jupiter response status:", quoteResponse.status);

    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      console.log("❌ Jupiter error body:", errorText);
      throw new Error(
        `Jupiter quote failed: ${quoteResponse.status} - ${errorText}`
      );
    }

    const quote = await quoteResponse.json();

    if (!quote.outAmount) {
      throw new Error(`No route found for ${tokenMint}`);
    }

    console.log(`💱 Quote: ${quote.outAmount} tokens for ${solAmount} SOL`);
    console.log(`💥 Price impact: ${quote.priceImpactPct || 0}%`);

    // 3. Get swap transaction
    console.log(`🔄 Creating swap transaction...`);
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: Math.floor((priorityFee || 0.00001) * 1e9),
      }),
    });

    if (!swapResponse.ok) {
      const errorData = await swapResponse.text();
      throw new Error(
        `Jupiter swap creation failed: ${swapResponse.status} - ${errorData}`
      );
    }

    const { swapTransaction } = await swapResponse.json();

    if (!swapTransaction) {
      throw new Error("No swap transaction returned from Jupiter");
    }

    // 4. Deserialize and sign transaction
    console.log(`✍️ Signing transaction...`);
    const transactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(transactionBuf);

    // Sign the transaction
    transaction.sign([wallet]);

    // 5. Send transaction
    console.log(`📤 Sending transaction to blockchain...`);
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    console.log(`🎯 Transaction sent: ${txid}`);

    // 6. Wait for confirmation
    console.log(`⏳ Waiting for confirmation...`);
    const confirmation = await connection.confirmTransaction({
      signature: txid,
      blockhash: (await connection.getLatestBlockhash()).blockhash,
      lastValidBlockHeight: (
        await connection.getLatestBlockhash()
      ).lastValidBlockHeight,
    });

    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    console.log(`✅ Transaction confirmed!`);

    // Calculate price (tokens per SOL)
    const tokensReceived = parseInt(quote.outAmount);
    const price = tokensReceived / solAmount;

    return {
      txid,
      price,
    };
  } catch (error) {
    console.error(`❌ Jupiter buy failed:`, error.message);
    throw error;
  }
}

export async function jupiter_sell(
  tokenMint: string,
  amountTokens: number
): Promise<{ txid: string; solReceived?: number }> {
  try {
    console.log(`💰 REAL Jupiter sell: ${amountTokens} tokens of ${tokenMint}`);

    // 1. Setup wallet and connection
    const privateKey = process.env.WALLET_SECRET;
    if (!privateKey) throw new Error("WALLET_SECRET not configured");

    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
    );

    console.log(`💰 Using wallet: ${wallet.publicKey.toString()}`);

    // 2. Get Jupiter quote (TOKEN → SOL)
    const quoteUrl =
      `https://quote-api.jup.ag/v6/quote?` +
      `inputMint=${tokenMint}&` + // Input: Your token
      `outputMint=So11111111111111111111111111111111111111112&` + // Output: SOL
      `amount=${Math.floor(amountTokens)}&` + // Amount of tokens to sell
      `slippageBps=300`; // Fixed 3% slippage for sells

    console.log(`📊 Getting sell quote from Jupiter...`);
    const quoteResponse = await fetch(quoteUrl);

    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      throw new Error(
        `Jupiter sell quote failed: ${quoteResponse.status} - ${errorText}`
      );
    }

    const quote = await quoteResponse.json();

    if (!quote.outAmount) {
      throw new Error(`No sell route found for ${tokenMint}`);
    }

    const solReceived = parseInt(quote.outAmount) / 1e9; // Convert lamports to SOL
    console.log(`💱 Sell quote: ${amountTokens} tokens → ${solReceived} SOL`);
    console.log(`💥 Price impact: ${quote.priceImpactPct || 0}%`);

    // 3. Get swap transaction
    console.log(`🔄 Creating sell transaction...`);
    const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 100000, // Fixed priority fee for sells
      }),
    });

    if (!swapResponse.ok) {
      const errorData = await swapResponse.text();
      throw new Error(
        `Jupiter sell swap creation failed: ${swapResponse.status} - ${errorData}`
      );
    }

    const { swapTransaction } = await swapResponse.json();

    if (!swapTransaction) {
      throw new Error("No sell swap transaction returned from Jupiter");
    }

    // 4. Deserialize and sign transaction
    console.log(`✍️ Signing sell transaction...`);
    const transactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(transactionBuf);

    // Sign the transaction
    transaction.sign([wallet]);

    // 5. Send transaction
    console.log(`📤 Sending sell transaction to blockchain...`);
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    console.log(`🎯 Sell transaction sent: ${txid}`);

    // 6. Wait for confirmation
    console.log(`⏳ Waiting for sell confirmation...`);
    const latestBlockhash = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction({
      signature: txid,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    if (confirmation.value.err) {
      throw new Error(
        `Sell transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    console.log(`✅ Sell transaction confirmed!`);

    return {
      txid,
      solReceived,
    };
  } catch (error) {
    console.error(`❌ Jupiter sell failed:`, error.message);
    throw error;
  }
}
