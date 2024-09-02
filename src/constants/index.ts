export const MAGICEDEN_CONTRACT_ADDRESS = "0x9A1D00bEd7CD04BCDA516d721A596eb22Aac6834"


export const SEAPORT_MIN_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "offerer", "type": "address" }
    ],
    "name": "getCounter",
    "outputs": [
      { "internalType": "uint256", "name": "counter", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  }
]
export const SEAPORT_CONTRACT_ADDRESS = '0x0000000000000068f116a894984e2db1123eb395';
export const WETH_MIN_ABI = [
  {
    "constant": false,
    "inputs": [
      { "name": "guy", "type": "address" },
      { "name": "wad", "type": "uint256" }
    ],
    "name": "approve",
    "outputs": [{ "name": "", "type": "bool" }],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  },

  {
    "constant": true,
    "inputs": [
      { "name": "", "type": "address" },
      { "name": "", "type": "address" }
    ],
    "name": "allowance",
    "outputs": [{ "name": "", "type": "uint256" }],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  }
]

export const WETH_CONTRACT_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"