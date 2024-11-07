import { ethers } from "ethers";
import { axiosInstance, limiter } from "../init";
const API_KEY = process.env.API_KEY


const provider = new ethers.providers.AlchemyProvider("mainnet", "0rk2kbu11E5PDyaUqX1JjrNKwG7s4ty5")
export async function getWethBalance(address: string): Promise<number> {
  try {
    const payload = {
      "id": "WalletPopoverDataPollerClosedQuery",
      "query": "query WalletPopoverDataPollerClosedQuery(\n  $address: AddressScalar!\n  $wrappedCurrencySymbol: String!\n  $wrappedCurrencyChain: ChainScalar!\n) {\n  ...WalletAndAccountButtonFundsDisplay_data_p0g3U\n}\n\nfragment FundsDisplay_walletFunds on WalletFundsType {\n  symbol\n  quantity\n}\n\nfragment WalletAndAccountButtonFundsDisplay_data_p0g3U on Query {\n  wallet(address: $address) {\n    wrappedCurrencyFunds: fundsOf(symbol: $wrappedCurrencySymbol, chain: $wrappedCurrencyChain) {\n      quantity\n      symbol\n      ...FundsDisplay_walletFunds\n      id\n    }\n  }\n}\n",
      "variables": {
        "address": address,
        "wrappedCurrencySymbol": "WETH",
        "wrappedCurrencyChain": "ETHEREUM"
      }
    }

    const { data } = await limiter.schedule(() => axiosInstance.post<WethBalanceResponse>(
      "https://api.nfttools.website/opensea/__api/graphql/",
      payload,
      {
        headers: {
          'x-nft-api-key': API_KEY,
          'x-auth-address': address,
          "x-signed-query": "51ab975e49c64eae0c01857a6fa0f29a3844856bfd4bbe3375321f6bcc4fdfac",
        },
      }
    ));

    return Number(data.data.wallet.wrappedCurrencyFunds.quantity);
  } catch (error) {
    console.error("Error fetching WETH balance:", error);
    return 0
  }
}

export async function getBethBalance(address: string): Promise<number> {
  try {
    const BLUR_POOL_ADDRESS = "0x0000000000A39bb272e79075ade125fd351887Ac";
    const wethContract = new ethers.Contract(BLUR_POOL_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
    const balance = await wethContract.balanceOf(address);
    return Number(ethers.utils.formatEther(balance));
  } catch (error) {
    console.error("Error fetching BETH balance:", error);
    return 0
    // throw error; // Rethrow the error after logging
  }
}


interface WethBalanceResponse {
  data: {
    wallet: {
      wrappedCurrencyFunds: {
        quantity: string;
        symbol: string;
        id: string;
      };
    };
  };
}