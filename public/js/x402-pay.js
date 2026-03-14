/**
 * x402 Payment Integration for CyberGavel Arena
 * Handles wallet connection and USDC payment via x402 protocol.
 * Overrides the placeholder payToUnlock() from app.js.
 */

(function () {
  'use strict';

  // Override payToUnlock with real x402 flow
  window.payToUnlock = async function () {
    const overlay = document.getElementById('paywall-overlay');
    const btn = overlay.querySelector('.btn-primary');
    const originalText = btn.textContent;

    try {
      // Step 1: Check if MetaMask / injected wallet exists
      if (!window.ethereum) {
        alert('Please install MetaMask or a compatible Web3 wallet to pay with USDC.');
        return;
      }

      btn.textContent = 'Connecting wallet...';
      btn.disabled = true;

      // Step 2: Request wallet connection
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || accounts.length === 0) {
        throw new Error('No wallet account found');
      }
      const payer = accounts[0];

      // Step 3: Fetch the report endpoint to get 402 payment requirements
      btn.textContent = 'Fetching payment details...';
      const reportUrl = `/api/analyze/${window.analysisId}/report`;
      const initialRes = await fetch(reportUrl);

      if (initialRes.status !== 402) {
        // No paywall — report is free (dev mode)
        if (initialRes.ok) {
          const data = await initialRes.json();
          unlockReport(data);
          return;
        }
        throw new Error(`Unexpected response: ${initialRes.status}`);
      }

      // Step 4: Parse x402 payment requirements from 402 response
      const paymentRequirements = await initialRes.json();
      const reqHeader = initialRes.headers.get('x-payment-requirements') ||
                        initialRes.headers.get('X-PAYMENT-REQUIREMENTS');

      let requirements;
      if (reqHeader) {
        requirements = JSON.parse(reqHeader);
      } else if (paymentRequirements && paymentRequirements.accepts) {
        requirements = paymentRequirements;
      } else if (Array.isArray(paymentRequirements)) {
        requirements = paymentRequirements[0];
      } else {
        throw new Error('Could not parse payment requirements from 402 response');
      }

      // Extract payment details
      const accepts = Array.isArray(requirements) ? requirements[0] :
                      (requirements.accepts ? (Array.isArray(requirements.accepts) ? requirements.accepts[0] : requirements.accepts) : requirements);

      const payTo = accepts.payTo;
      const network = accepts.network;
      const priceRaw = accepts.price || accepts.maxAmountRequired;

      // Step 5: Determine amount and token
      btn.textContent = 'Preparing payment...';

      // Parse price — "$5.00" or { asset, amount }
      let tokenAddress, amountWei;
      if (typeof priceRaw === 'string' && priceRaw.startsWith('$')) {
        const usdAmount = parseFloat(priceRaw.replace('$', ''));
        // USDC has 6 decimals
        amountWei = BigInt(Math.round(usdAmount * 1e6)).toString(16);
        // USDC contract addresses
        const usdcAddresses = {
          'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',   // Base mainnet
          'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',  // Base Sepolia
        };
        tokenAddress = usdcAddresses[network];
        if (!tokenAddress) throw new Error(`Unsupported network: ${network}`);
      } else if (priceRaw && priceRaw.asset) {
        tokenAddress = priceRaw.asset;
        amountWei = BigInt(priceRaw.amount).toString(16);
      } else {
        throw new Error('Could not parse price from payment requirements');
      }

      // Step 6: Switch to correct chain if needed
      const chainId = network.split(':')[1];
      const hexChainId = '0x' + parseInt(chainId).toString(16);
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });

      if (currentChainId !== hexChainId) {
        btn.textContent = 'Switching network...';
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: hexChainId }],
          });
        } catch (switchErr) {
          if (switchErr.code === 4902) {
            // Chain not added — add Base
            const chainConfigs = {
              '0x2105': { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
              '0x14a34': { chainId: '0x14a34', chainName: 'Base Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] },
            };
            if (chainConfigs[hexChainId]) {
              await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [chainConfigs[hexChainId]] });
            } else {
              throw new Error(`Please manually switch to chain ${chainId}`);
            }
          } else {
            throw switchErr;
          }
        }
      }

      // Step 7: Approve and transfer USDC via ERC-20 transfer
      btn.textContent = 'Confirm payment in wallet...';

      // ERC-20 transfer(address,uint256) function selector
      const transferSelector = '0xa9059cbb';
      const paddedTo = payTo.slice(2).padStart(64, '0');
      const paddedAmount = amountWei.padStart(64, '0');
      const txData = transferSelector + paddedTo + paddedAmount;

      const txHash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: payer,
          to: tokenAddress,
          data: txData,
          value: '0x0',
        }],
      });

      // Step 8: Wait for confirmation
      btn.textContent = 'Waiting for confirmation...';
      await waitForTx(txHash);

      // Step 9: Retry report fetch with payment proof
      btn.textContent = 'Verifying payment...';

      // Build x402 payment header with tx proof
      const paymentPayload = JSON.stringify({
        scheme: 'exact',
        network: network,
        payload: {
          txHash: txHash,
          payer: payer,
        },
      });

      const paidRes = await fetch(reportUrl, {
        headers: {
          'X-PAYMENT': btoa(paymentPayload),
          'Payment-Signature': btoa(paymentPayload),
        },
      });

      if (!paidRes.ok) {
        // If x402 verification fails, still unlock locally since payment was sent on-chain
        console.warn('x402 verification response:', paidRes.status);
        // Fallback: unlock anyway — the USDC transfer already happened
        document.getElementById('blurred-content').classList.add('unlocked');
        document.getElementById('paywall-overlay').classList.add('hidden');
        return;
      }

      const data = await paidRes.json();
      unlockReport(data);

    } catch (err) {
      console.error('[x402]', err);
      btn.textContent = originalText;
      btn.disabled = false;

      if (err.code === 4001) {
        // User rejected
        return;
      }
      alert('Payment failed: ' + err.message);
    }
  };

  // Unlock the report UI with data
  function unlockReport(data) {
    document.getElementById('blurred-content').classList.add('unlocked');
    document.getElementById('paywall-overlay').classList.add('hidden');

    // If we got report data, render it
    if (data && data.report) {
      // Trigger report rendering if viewReport function exists
      if (typeof window.renderFullReport === 'function') {
        window.renderFullReport(data.report);
      }
    }
  }

  // Wait for transaction confirmation
  async function waitForTx(txHash, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      const receipt = await window.ethereum.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt && receipt.blockNumber) {
        if (receipt.status === '0x0') throw new Error('Transaction reverted');
        return receipt;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Transaction confirmation timeout');
  }

})();
