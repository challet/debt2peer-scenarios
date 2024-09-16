import { Asset, Horizon, Keypair, Memo, MemoText, Operation } from '@stellar/stellar-sdk';
import { describe, expect, it } from '@jest/globals';

import { buildTransaction, findBalance, horizon, rpcserver, BalanceLineAsset, User, OfferRecord } from './utils.ts';


const ASSET_CODE = 'IOU000000USD';
const NO_CROSS_EXPECTATION = expect.objectContaining({
  isFullyOpen: true,
  wasPartiallyFilled: false,
  wasImmediatelyFilled: false,
  wasImmediatelyDeleted: false,
  amountBought: '0',
  amountSold: '0'
});

// David would be the operator funding the transactions, and not taking part in them
// Alice and Bob would be our regular users
// Susie would be a third party making trustlines path between our primary users
// Matilda would be a merchant outside the {Alice, Bob, Susie } cluster only trusting Susie
var users: Record<string, User> = {};

beforeAll(async() => {
  // Create an operator (David). It will be used as a source for bundled transactions
  // TODO use David as a sponsor for reserve increasing operations
  const keypair = Keypair.random();
  await horizon.friendbot(keypair.publicKey()).call();
  users.David = {
    keypair,
    account: await rpcserver.getAccount(keypair.publicKey())
  };

  // Create our other users accounts
  const names = ['Alice', 'Bob', 'Susie', 'Matilda'];
  const trx = buildTransaction(names.map((name) => {
    users[name] = { keypair: Keypair.random() };
    return Operation.createAccount({
      destination: users[name].keypair.publicKey(),
      startingBalance: '50'
    });
  }), [users.David]);
  await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

  // store some data for ease of use in the following tests
  await Promise.all(names.map(async (name) => {
    users[name].account = await rpcserver.getAccount(users[name].keypair.publicKey());
    users[name].iou = new Asset(ASSET_CODE, users[name].keypair.publicKey());
    console.debug(`${name} account created at '${users[name].keypair.publicKey()}'`);
  }));
});

describe('Credit and debt management', () => {
  it('Alice creates a trustline on Bob\'s IOU', async () => {
    const trx = buildTransaction([
      Operation.changeTrust({
        source: users.Alice.account.accountId(),
        asset: users.Bob.iou,
        limit: '1000'
      })
    ], [users.Alice]);
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    const balance = await findBalance(users.Alice, users.Bob.iou);
    expect(balance).toBeDefined();
    expect(balance).toBe(0);
  });

  it('Bob issues 500 IOU to Alice', async() => {
    const trx = buildTransaction([
      Operation.payment({
        source: users.Bob.account.accountId(),
        asset: users.Bob.iou,
        destination: users.Alice.account.accountId(),
        amount: '500'
      })
    ], [users.Bob]);
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    expect(await findBalance(users.Alice, users.Bob.iou)).toBe(500);
  });

  it('Bob creates a reverse trustline and Alice issues 300 IOU on it', async () => {
    const trx = buildTransaction([
        Operation.changeTrust({
          source: users.Bob.account.accountId(),
          asset: users.Alice.iou,
          limit: '1000'
        }),
        Operation.payment({
          source: users.Alice.account.accountId(),
          asset: users.Alice.iou,
          destination: users.Bob.account.accountId(),
          amount: '300'
        })
      ],
      [users.David, users.Bob, users.Alice]
    );
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    expect(await findBalance(users.Bob, users.Alice.iou)).toBe(300);
  });
});

describe('Settlements', () => {
  it('Alice sends back 100 Bob\'s IOU to Bob', async () => {
    const trx = buildTransaction([
      Operation.payment({ 
        source: users.Alice.account.accountId(),
        asset: users.Bob.iou,
        destination: users.Bob.account.accountId(),
        amount: '100'
      })
    ], [users.Alice]);
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    expect(await findBalance(users.Alice, users.Bob.iou)).toBe(400); // 500 - 100
  });

  it('Alice and Bob each sell their counterpart IOU and buyback their own', async () => {
      const trx = buildTransaction([
        Operation.manageSellOffer({
          source: users.Alice.account.accountId(),
          buying: users.Alice.iou,
          selling: users.Bob.iou,
          price: 1,
          amount: '400'
        }),
        Operation.manageSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Bob.iou,
          selling: users.Alice.iou,
          price: 1,
          amount: '300'
        })
      ],
      [users.David, users. Bob, users.Alice]
    );
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    const [balance_a, balance_b] = await Promise.all([
      findBalance(users.Alice, users.Bob.iou),
      findBalance(users.Bob, users.Alice.iou)
    ]);
    expect(balance_a).toBe(100); // 400 - 100
    expect(balance_b).toBe(0); // 300 - 300
  });

  it('Alice sends back the remaining 100 Bob\'s IOU but needs to free their buy offer prior to it', async() => {
    // Alice wants to sell 100 Bob's IOU for 100 of their own IOU
    const account = await horizon.loadAccount(users.Alice.account.accountId());
    const balance = account.balances.find((balance): balance is Horizon.HorizonApi.BalanceLineAsset => {
      return balance.asset_type === "credit_alphanum12" 
        && balance.asset_code == users.Bob.iou.getCode()
        && balance.asset_issuer == users.Bob.iou.getIssuer()
    });
    // it cannot be send because the amount required is held by a sell offer
    expect(parseFloat(balance.balance) - parseFloat(balance.selling_liabilities)).toBeLessThan(100);

    // find it so it can be updated accordingly
    const offers = await horizon.offers()
      .forAccount(users.Alice.account.accountId())
      .selling(users.Bob.iou)
      .call();

    const trx = buildTransaction([
      Operation.manageSellOffer({
        source: users.Alice.account.accountId(),
        buying: users.Alice.iou,
        selling: users.Bob.iou,
        price: 1,
        amount: '0',
        offerId: offers.records[0].id
      }),
      Operation.payment({
        source: users.Alice.account.accountId(),
        asset: users.Bob.iou,
        destination: users.Bob.account.accountId(),
        amount: '100'
      })
    ], [users.Alice]);
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    expect(await findBalance(users.Alice, users.Bob.iou)).toBe(0); // 100 - 100
  });

  it('Susie joins Alice and Bob, they all trust each other ', async() => {
    const trx = buildTransaction([
      Operation.changeTrust({
        source: users.Alice.account.accountId(),
        asset: users.Susie.iou,
        limit: '1000'
      }),
      Operation.changeTrust({
        source: users.Susie.account.accountId(),
        asset: users.Alice.iou,
        limit: '1000'
      }),
      Operation.changeTrust({
        source: users.Susie.account.accountId(),
        asset: users.Bob.iou,
        limit: '1000'
      }),
      Operation.changeTrust({
        source: users.Bob.account.accountId(),
        asset: users.Susie.iou,
        limit: '1000'
      }),
    ], [users.David, users.Bob, users.Alice, users.Susie]);
    const result = await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    const balances = await Promise.all([
      findBalance(users.Alice, users.Susie.iou),
      findBalance(users.Susie, users.Alice.iou),
      findBalance(users.Bob, users.Susie.iou),
      findBalance(users.Susie, users.Bob.iou),
    ]);
    expect(balances).toEqual([0, 0, 0, 0]);
  });

  it('Alice issues 100 to Bob, Bob 200 to Susie, Susie 300 to Alice. Each recipient creates an order to sell them back (and buyback their own-issued IOU)', async () => {
    const trx = buildTransaction([
      Operation.payment({
        source: users.Alice.account.accountId(),
        asset: users.Alice.iou,
        destination: users.Bob.account.accountId(),
        amount: '100'
      }),
      Operation.manageSellOffer({
        source: users.Bob.account.accountId(),
        buying: users.Bob.iou,
        selling: users.Alice.iou,
        price: 1,
        amount: '100'
      }),
      Operation.payment({
        source: users.Bob.account.accountId(),
        asset: users.Bob.iou,
        destination: users.Susie.account.accountId(),
        amount: '200'
      }),
      Operation.manageSellOffer({
        source: users.Susie.account.accountId(),
        buying: users.Susie.iou,
        selling: users.Bob.iou,
        price: 1,
        amount: '200'
      }),
      Operation.payment({
        source: users.Susie.account.accountId(),
        asset: users.Susie.iou,
        destination: users.Alice.account.accountId(),
        amount: '300'
      }),
      Operation.manageSellOffer({
        source: users.Alice.account.accountId(),
        buying: users.Alice.iou,
        selling: users.Susie.iou,
        price: 1,
        amount: '300'
      })
    ], [users.David, users.Bob, users.Alice, users.Susie]);
    const result = await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    const balances = await Promise.all([
      findBalance(users.Bob, users.Alice.iou),
      findBalance(users.Susie, users.Bob.iou),
      findBalance(users.Alice, users.Susie.iou)
    ]);
    expect(balances).toEqual([100, 200, 300]);
  });

  it('Alice sends 100 Susie\'s IOU to Bob', async () => {
    // find the current Alice's offer to sell Susie's IOU
    const offers = await horizon.offers()
      .forAccount(users.Alice.account.accountId())
      .selling(users.Susie.iou)
      .call();

      const trx_pay = buildTransaction([
        // Decrease the sell offer to free up liability
        Operation.manageSellOffer({
          source: users.Alice.account.accountId(),
          buying: users.Alice.iou,
          selling: users.Susie.iou,
          price: 1,
          amount: '200',
          offerId: offers.records[0].id
        }),
        Operation.payment({
          source: users.Alice.account.accountId(),
          asset: users.Susie.iou,
          destination: users.Bob.account.accountId(),
          amount: '100'
        })
      ], [users.Alice]);
      const res = await horizon.submitTransaction(trx_pay, { skipMemoRequiredCheck: true });

      const balances = await Promise.all([
        findBalance(users.Alice, users.Susie.iou),
        findBalance(users.Bob, users.Susie.iou)
      ]);
      expect(balances).toEqual([200, 100]);
  });

  it('Alice compensates 100 IOU through a cyclic path (Alice -> Susie -> Bob -> Alice)', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000)); // There is a small delay before the paths become available to fetch on Horizon
    const paths = await horizon.strictReceivePaths([users.Susie.iou], users.Alice.iou, '100').call();
    const path = paths.records[0];

    expect(path).toEqual(expect.objectContaining({
      // Alice sends Susie's IOU`
      source_asset_code: users.Susie.iou.getCode(),
      source_asset_issuer: users.Susie.iou.getIssuer(),
      // Alice recevied Alice's IOU
      destination_asset_code: users.Alice.iou.getCode(),
      destination_asset_issuer: users.Alice.iou.getIssuer(),
      source_amount: '100.0000000',
      destination_amount: '100.0000000',
      // Susie's IOU is exchanged for Bob's IOU, which is exchanged for Alice's IOU
      path: expect.arrayContaining([expect.objectContaining({
        asset_code: users.Bob.iou.getCode(),
        asset_issuer: users.Bob.iou.getIssuer()
      })])
    }));

    // find the current Alice's offer to sell Susie's IOU
    const offers = await horizon.offers()
      .forAccount(users.Alice.account.accountId())
      .selling(users.Susie.iou)
      .call();

    const trx = buildTransaction([
      // Decrease the sell offer to free up liability
      Operation.manageSellOffer({
        source: users.Alice.account.accountId(),
        buying: users.Alice.iou,
        selling: users.Susie.iou,
        price: 1,
        amount: '100',
        offerId: offers.records[0].id
      }),
      Operation.pathPaymentStrictReceive({
        source: users.Alice.account.accountId(),
        sendAsset: users.Susie.iou,
        sendMax: '100',
        destination: users.Alice.account.accountId(),
        destAsset: users.Alice.iou,
        destAmount: '100',
        path: [users.Bob.iou]
      })
    ], [users.Alice]);

    try {
      await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });
    } catch (e) {
      console.error(e.response.data.extras.result_codes);
    }
    const balances = await Promise.all([
      findBalance(users.Bob, users.Alice.iou),
      findBalance(users.Susie, users.Bob.iou),
      findBalance(users.Alice, users.Susie.iou)
    ]);
    expect(balances).toEqual([0, 100, 100]); // they all have 100 IOU less
  });

  it('Alice sends 100 IOU to Bob\'s through a PathPayment including Susie', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000)); // There is a small delay before the paths become available to fetch on Horizon
    const paths = await horizon.strictReceivePaths(users.Alice.account.accountId(), users.Bob.iou, '100').call();
    const path = paths.records.filter((path) => path.source_asset_issuer !== path.destination_asset_issuer)[0];

    expect(path).toEqual(expect.objectContaining({
      source_asset_code: users.Susie.iou.getCode(),
      source_asset_issuer: users.Susie.iou.getIssuer(),
      destination_asset_code: users.Bob.iou.getCode(),
      destination_asset_issuer: users.Bob.iou.getIssuer(),
      source_amount: '100.0000000',
      destination_amount: '100.0000000',
      path: expect.not.arrayContaining([expect.anything()])
    }));
    
    // find the current Alice's offer to sell Susie's IOU
    const offers = await horizon.offers()
      .forAccount(users.Alice.account.accountId())
      .selling(users.Susie.iou)
      .call();
  
    const trx_pay = buildTransaction([
      // Decrease the sell offer to free up liability (it will actually be removed with a 0 amount)
      Operation.manageSellOffer({
        source: users.Alice.account.accountId(),
        buying: users.Alice.iou,
        selling: users.Susie.iou,
        price: 1,
        amount: '0',
        offerId: offers.records[0].id
      }),
      Operation.pathPaymentStrictReceive({
        source: users.Alice.account.accountId(),
        sendAsset: users.Susie.iou,
        sendMax: '100',
        destination: users.Bob.account.accountId(),
        destAsset: users.Bob.iou,
        destAmount: '100',
        path: []
      })
    ], [users.Alice]);
    const res = await horizon.submitTransaction(trx_pay, { skipMemoRequiredCheck: true });

    const [balance_a, balance_s] = await Promise.all([
      findBalance(users.Alice, users.Susie.iou),
      findBalance(users.Susie, users.Bob.iou)
    ]);
    expect(balance_a).toBe(0); // Alice has been paying by decreasing Susie's IOU she owns
    expect(balance_s).toBe(0); // Bob has been paid by having its IOU previously owned by Susie sent back to him
  });
});

describe('Liquidity provision and payment without a direct trustline', () => {
  it('Matilda joins and trusts Susie\'s IOU', async() => {
    const trx = buildTransaction([
      Operation.changeTrust({
        source: users.Matilda.account.accountId(),
        asset: users.Susie.iou,
        limit: '1000'
      })
    ], [users.Matilda]);
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    const balance = await findBalance(users.Matilda, users.Susie.iou);
    expect(balance).not.toBeUndefined();
  });

  describe('Liquidity provision intents can be registered then fetched on-chain', () => {
    it('Bob registers intent to provide liquidity for Alice', async () => {
      const trx = buildTransaction([
          Operation.changeTrust({
            source: users.Bob.account.accountId(),
            asset: users.Alice.iou,
            limit: '1000'
          }),
          // so we can test the paging loop in the next test
          Operation.manageData({
            source: users.Bob.account.accountId(),
            name: 'data',
            value: 'entry'
          })
        ],
        [users.David, users.Bob],
        new Memo(MemoText, "PI:500")
      );
      const result = await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

      expect((result as any).memo).toBe("PI:500");
    });

    it('Bob liquidity provision intent is retrieved from the trustline', async() => {
      let op_lookup = null;
      let fetch_tx = horizon.operations()
        .forAccount(users.Bob.account.accountId())
        .order('desc')
        .limit(1) // so we can test the paging loop
        .call();
      do {
        const operations = await fetch_tx;
        op_lookup = operations.records.find(op => op.type == 'change_trust');

        if (!op_lookup) {
          fetch_tx = operations.records.length == 0 ? null : operations.next();
        }
      } while(op_lookup == null && fetch_tx != null);

      expect(op_lookup.transaction()).resolves.toEqual(expect.objectContaining({memo: "PI:500"}));
    });
  });

  it('Bob provides liquidity to Alice and Susie to Bob', async() => {
    const trx = buildTransaction([
      Operation.createPassiveSellOffer({
        source: users.Bob.account.accountId(),
        buying: users.Alice.iou,
        selling: users.Bob.iou,
        amount: '100',
        price: 1
      }),
      Operation.createPassiveSellOffer({
        source: users.Susie.account.accountId(),
        buying: users.Bob.iou,
        selling: users.Susie.iou,
        amount: '200',
        price: 1
      })
    ], [users.David, users.Bob, users.Susie]);
    const result = await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    await new Promise((resolve) => setTimeout(resolve, 2000)); // There is a small delay before the paths become available to fetch on Horizon
    const paths = await horizon.strictSendPaths(users.Alice.iou, '100', users.Matilda.account.accountId()).call();

    expect(paths.records).toContainEqual(expect.objectContaining({
      source_asset_code: users.Alice.iou.getCode(),
      source_asset_issuer: users.Alice.iou.getIssuer(),
      destination_asset_code: users.Susie.iou.getCode(),
      destination_asset_issuer: users.Susie.iou.getIssuer(),
      source_amount: '100.0000000',
      destination_amount: '100.0000000',
      path: expect.arrayContaining([
        expect.objectContaining({
          asset_code: users.Bob.iou.getCode(),
          asset_issuer: users.Bob.iou.getIssuer()
        })
      ])
    }));
  });

  it('Alice sends 100 IOU to Matilda without a direct trust and through the provided liquidity', async() => {
    const trx = buildTransaction([
      Operation.pathPaymentStrictSend({
        source: users.Alice.account.accountId(),
        sendAsset: users.Alice.iou,
        sendAmount: '100',
        destination: users.Matilda.account.accountId(),
        destAsset: users.Susie.iou,
        destMin: '100',
        path: [users.Bob.iou]
      })
    ], [users.Alice]);
    await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

    const balances = await Promise.all([
      findBalance(users.Bob, users.Alice.iou),
      findBalance(users.Susie, users.Bob.iou),
      findBalance(users.Matilda, users.Susie.iou)
    ]);
    expect(balances[0]).toBe(100);
    expect(balances[1]).toBe(100);
    expect(balances[2]).toBe(100);
  });


  describe('Dealing with self-cross offers', () => {
    it('A buyback offer will self-cross a previously existing (passive) liquidity provision offer', async () => {
      // Alice issues 100 IOU to Bob 
      const trx = buildTransaction([
        // Bow wants to provide liquidity to Alice
        Operation.createPassiveSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Alice.iou,
          selling: users.Bob.iou,
          amount: '100',
          price: 1
        }),
        Operation.payment({
          source: users.Alice.account.accountId(),
          asset: users.Alice.iou,
          destination: users.Bob.account.accountId(),
          amount: '100'
        }),
        // Bob wants to sell it back in exchange for its own IOU
        Operation.manageSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Bob.iou,
          selling: users.Alice.iou,
          amount: '100',
          price: 1,
        })
      ], [users.David, users.Alice, users.Bob]);

      // So there is a self crossing deal 
      await expect(horizon.submitTransaction(trx, { skipMemoRequiredCheck: true }))
        .rejects.toThrow(expect.objectContaining({
          response: expect.objectContaining({
            data: expect.objectContaining({
              extras: expect.objectContaining({ 
                result_codes: expect.objectContaining({
                  operations: expect.arrayContaining(['op_cross_self'])
                })
              })
            })
          })
        }));
    });

    it('However a (passive) liquidity provision offer won\'t self-cross a previous buyback offer', async () => {
      const trx = buildTransaction([
        // Alice issues 100 IOU to Bob 
        Operation.payment({
          source: users.Alice.account.accountId(),
          asset: users.Alice.iou,
          destination: users.Bob.account.accountId(),
          amount: '100'
        }),
        // Bob wants to sell it back in exchange for its own IOU
        Operation.manageSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Bob.iou,
          selling: users.Alice.iou,
          amount: '100',
          price: 1,
        }),
        // Bow also wants to provide liquidity to Alice
        Operation.createPassiveSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Alice.iou,
          selling: users.Bob.iou,
          amount: '100',
          price: 1
        }),
      ], [users.David, users.Alice, users.Bob]);
      const result = await horizon.submitTransaction(trx, { skipMemoRequiredCheck: true });

      // check that potential self-crossing offers are published anyway
      const offerResults = (result as any).offerResults;
      expect(offerResults[0].currentOffer.selling).toEqual(offerResults[1].currentOffer.buying);
      expect(offerResults[1].currentOffer.selling).toEqual(offerResults[0].currentOffer.buying);
      expect(offerResults[0].currentOffer.price).toEqual(offerResults[1].currentOffer.price);
      expect(offerResults[0]).toEqual(NO_CROSS_EXPECTATION);
      expect(offerResults[1]).toEqual(NO_CROSS_EXPECTATION);

      // Check again with querying the offers
      await new Promise((resolve) => setTimeout(resolve, 2000)); // There is a small delay before the offers become available to fetch on Horizon
      const offers = await horizon.offers().forAccount(users.Bob.account.accountId()).call();
      const offersAccount = await Promise.all(offers.records.map((offer: OfferRecord) => offer.offer_maker()));

      expect(offersAccount[0].id).toBe(offersAccount[1].id);
      expect(offers.records[0].price).toEqual(offers.records[1].price);
      expect(offers.records[0].selling).toEqual(offers.records[1].buying);
      expect(offers.records[0].buying).toEqual(offers.records[1].selling);
    });

    it('If a liquidity provision exists, the buyback offer can be sandwiched between a liquidity provision deletion and a re-creation', async () => {
      const [provision_offer, buyack_offer] = await Promise.all([
        // In order to make a buyback offer on it (or update an existing one), Bob needs to act on his liquidity provision first
        horizon.offers()
          .seller(users.Bob.account.accountId())
          .selling(users.Bob.iou)
          .buying(users.Alice.iou)
          .call(),
        // He also needs to find whether a buyback offer can be updated
        horizon.offers()
          .seller(users.Bob.account.accountId())
          .selling(users.Alice.iou)
          .buying(users.Bob.iou)
          .call()
      ]);

      const update_trx = buildTransaction([
        // Delete the provision offer
        Operation.manageSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Bob.iou,
          selling: users.Alice.iou,
          amount: '0',
          price: 1,
          offerId: provision_offer.records[0].id
        }),
        // Update the buyback offer
        Operation.manageSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Bob.iou,
          selling: users.Alice.iou,
          amount: '200',
          price: 1,
          offerId: buyack_offer.records[0].id
        }),
        // Re-create the provision offer
        Operation.createPassiveSellOffer({
          source: users.Bob.account.accountId(),
          buying: users.Alice.iou,
          selling: users.Bob.iou,
          amount: '100',
          price: 1
        }),
      ], [users.David, users.Bob]);
      await horizon.submitTransaction(update_trx, { skipMemoRequiredCheck: true });

      await new Promise((resolve) => setTimeout(resolve, 2000)); // There is a small delay before the paths become available to fetch on Horizon
      // Check that the path payment works with liquidity provisions
      // It is the same operation as in the previous test "Alice sends 100 IOU to Matilda without a direct trust and through the provided liquidity"
      const payment_trx = buildTransaction([
        Operation.pathPaymentStrictSend({
          source: users.Alice.account.accountId(),
          sendAsset: users.Alice.iou,
          sendAmount: '100',
          destination: users.Matilda.account.accountId(),
          destAsset: users.Susie.iou,
          destMin: '100',
          path: [users.Bob.iou]
        })
      ], [users.Alice]);
      await horizon.submitTransaction(payment_trx, { skipMemoRequiredCheck: true });
  
      const balances = await Promise.all([
        findBalance(users.Bob, users.Alice.iou),
        findBalance(users.Susie, users.Bob.iou),
        findBalance(users.Matilda, users.Susie.iou)
      ]);
      // Each have 100 from "Alice sends 100 IOU to Matilda without a direct trust and through the provided liquidity"
      expect(balances[0]).toBe(300); // + 100 from "Alice issues 100 IOU to Bob" + 100 from the above PathPayment
      expect(balances[1]).toBe(200); // + 100 from the above PathPayment
      expect(balances[2]).toBe(200); // + 100 from the above PathPayment
    });

  });


});