import { Account, Horizon, Keypair, Memo, Networks, TransactionBuilder, rpc, xdr, BASE_FEE, Asset } from '@stellar/stellar-sdk';

export type User = {
  keypair: Keypair,
  account?: Account,
  iou?: Asset
};

export type OfferRecord = Horizon.ServerApi.OfferRecord & { offer_maker: ReturnType<typeof horizon.accounts.call> };
export type BalanceLineAsset = Horizon.HorizonApi.BalanceLineAsset;

export const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
export const rpcserver = new rpc.Server('https://soroban-testnet.stellar.org');

export function buildTransaction(operations: xdr.Operation[], signers: [User, ...User[]], memo?: Memo) {
  // build the transactions with common parameters, the source is always the first signer
  const build = new TransactionBuilder(signers[0].account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  operations.forEach((operation) => build.addOperation(operation));

  if (memo) {
    build.addMemo(memo);
  }

  const trx = build.setTimeout(30).build();

  // sign the transaction
  trx.sign(...signers.map((signer) => signer.keypair));

  // TODO also submit the transaction here (?)

  return trx;
};

export async function findBalance(owner: User, asset: Asset): Promise<number|undefined> {
  const account = await horizon.loadAccount(owner.account.accountId());
  const balance = account.balances.find((balance) => {
    return balance.asset_type === "credit_alphanum12" 
      && balance.asset_code == asset.getCode()
      && balance.asset_issuer == asset.getIssuer()
  });

  return balance === undefined ? undefined : parseFloat(balance.balance);
};
