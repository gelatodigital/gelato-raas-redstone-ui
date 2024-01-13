import { useEffect, useState } from "react";
import { Status, State, TaskState, Message } from "../../types/Status";
import { BiRefresh, BiCopy } from "react-icons/bi";
import { firstValueFrom, interval, pipe, Subject, take, takeUntil } from "rxjs";
import { Contract, Wallet, ethers } from "ethers";
import metamask from "../../assets/images/metamask.png";
import Header from "../Header";
import * as sdk from "@redstone-finance/sdk";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { DataPackagesWrapper } from "@redstone-finance/evm-connector/dist/src/wrappers/DataPackagesWrapper";
import PriceFeedAdapterJson from "../../assets/contracts/PriceFeedAdapterXAU.json";
import SimplePriceFeedConsumerJson from "../../assets/contracts/SimplePriceFeedConsumer.json";
import MulticallJson from "../../assets/contracts/Multicall.json";
import "./style.css";

import Loading from "../Loading";
import Button from "../Button";
import { LocalStorage } from "../../session/storage/local-storage";
import { StorageKeys } from "../../session/storage/storage-keys";


export interface IORDER {
  orderId: number;
  price: number;
  publishTime?: number;
  priceSettled: number;

}

const App = () => {
  let destroyFetchTask: Subject<void> = new Subject();

  const localStorage = new LocalStorage();

  const [priceFeedAdapter, setPriceFeedAdapter] = useState<Contract>();
  const [simplePriceFeedConsumer, setSimplePriceFeedConsumer] =
    useState<Contract>();

  const [signerAddress, setSignerAddress] = useState<string | null>(null);

  const [ready, setReady] = useState(false);
  const [price, setPrice] = useState<{
    price: number;
    dataPackagesResponse: sdk.DataPackagesResponse | null;
  }>({ price: 0, dataPackagesResponse: null });

  const [provider, setProvider] =
    useState<ethers.providers.Web3Provider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [message, setMessage] = useState<Message>({
    header: "Loading",
    body: undefined,
    taskId: undefined,
  });

  const [orders, setOrders] = useState<Array<IORDER>>([]);

  const [connectStatus, setConnectStatus] = useState<Status | null>({
    state: State.missing,
    message: "Loading",
  });

  if (typeof window.ethereum != "undefined") {
    window.ethereum.on("accountsChanged", () => {
      const web3Provider = new ethers.providers.Web3Provider(window.ethereum);
      setLoading(true);
      refresh(web3Provider);
    });

    window.ethereum.on("chainChanged", async () => {
      const web3Provider = new ethers.providers.Web3Provider(window.ethereum);
      setLoading(true);
      refresh(web3Provider);
  
      const currentChainId = await window.ethereum.request({
        method: "eth_chainId",
      });

      if (currentChainId !== "0x4737") {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x4737" }],
        });
      }
    });
  }

  const onDisconnect = async () => {
    setConnectStatus({
      state: State.failed,
      message: "Waiting for Disconnection",
    });
    localStorage.remove(StorageKeys.SESSION_ID);
    localStorage.remove(StorageKeys.SESSION_KEY);
    await window.ethereum.request({
      method: "eth_requestAccounts",
      params: [
        {
          eth_accounts: {},
        },
      ],
    });
  };

  const onConnect = async () => {
    try {
      await window.ethereum.request({
        method: "wallet_requestPermissions",
        params: [
          {
            eth_accounts: {},
          },
        ],
      });
      const web3Provider = new ethers.providers.Web3Provider(window.ethereum);
      setLoading(true);
      refresh(web3Provider);
      localStorage.remove(StorageKeys.SESSION_ID);
      localStorage.remove(StorageKeys.SESSION_KEY);
    } catch (error) {}
  };

  const onCopy = async (text: string) => {
    if ("clipboard" in navigator) {
      await navigator.clipboard.writeText(text);
    } else {
      document.execCommand("copy", true, text);
    }
    alert("Copied to Clipboard");
  };

  const onAction = async (action: number) => {
    switch (action) {
      case 0:
        setOrder();
        break;
      default:
        setLoading(false);
        break;
    }
  };

  const parsePrice = (value: Uint8Array) => {
    const bigNumberPrice = ethers.BigNumber.from(value);
    return bigNumberPrice.toNumber() / 10 ** 8; // Redstone uses 8 decimals
  };

  const getPrice = async (
    provider: ethers.providers.Web3Provider,
    signerAddress: string
  ) => {
    if (price.price != 0) {
      return;
    }

    const numbers = interval(2000);

    const takeFourNumbers = numbers.pipe(takeUntil(destroyFetchTask));

    takeFourNumbers.subscribe(async (x) => {
      console.log(x)
      try {
        const dataPackagesResponse = await sdk.requestDataPackages({
          dataServiceId: "redstone-main-demo",
          uniqueSignersCount: 1,
          dataFeeds: ["XAU"],
          urls: ["https://oracle-gateway-1.b.redstone.finance"],
        });
    
        const { dataPackage } = dataPackagesResponse["XAU"]![0];
        console.log(dataPackage)

        const parsedPrice = parsePrice(dataPackage.dataPoints[0].value);

        setPrice({
          price: parsedPrice,
          dataPackagesResponse: dataPackagesResponse,
        });
      } catch (error) {}
    });
  };
  //  static componentWillUnmount() {
  //     alert("The component named Header is about to be unmounted.");
  //   }

  const setOrder = async () => {
    try {
      setMessage({
        header: "Waiting for tx...",
        body: undefined,
        taskId: undefined,
      });
      setLoading(true);
      let simplePriceFeedContract = await getSimplePriceFeedConsumer(provider!);
      const wrapper = new DataPackagesWrapper(price.dataPackagesResponse!);
      const redstonePayload = await wrapper.getRedstonePayloadForManualUsage(
        simplePriceFeedConsumer!
      );

      const { dataPackage } = price.dataPackagesResponse!["XAU"]![0];
      // You can read more about redstone payload structure here: https://docs.redstone.finance/docs/smart-contract-devs/how-it-works#data-packing-off-chain-data-encoding
      console.log(`Redstone payload: ${redstonePayload}`);
      const redstonePayloadWithoutZeroEx = redstonePayload.replaceAll("0x", "");

      // Prepare the call with the prices update
      const callWithPriceUpdateInAdapter = {
        target: priceFeedAdapter!.address,
        callData:
          priceFeedAdapter!.interface.encodeFunctionData(
            "updateDataFeedsValues",
            [dataPackage.timestampMilliseconds]
          ) + redstonePayloadWithoutZeroEx,
      };

      // Prepare the actual call on the consumer contract (with the business logic)
      let readyPrice = +(price.price * 100000000).toFixed(0);
      const callOnConsumerContract = {
        target: simplePriceFeedConsumer!.address,
        callData: simplePriceFeedConsumer!.interface.encodeFunctionData(
          "doSomethingWithPrice",
          [readyPrice]
        ),
      };
      const signer = await provider?.getSigner();

      const multicall = new ethers.Contract(
        MulticallJson.address,
        MulticallJson.abi,
        signer
      );

      const multicallTx = await multicall.aggregate([
        callWithPriceUpdateInAdapter,
        callOnConsumerContract,
      ]);
      await multicallTx.wait();

      setTimeout(() => {
        doRefresh();
      }, 1000);
    } catch (error) {
      console.log(error);
      setLoading(false);
    }
  };

  const doRefresh = async () => {
    setMessage({
      header: "Refreshing Balance....",
      body: undefined,
      taskId: undefined,
    });
    setLoading(true);
    await refresh(provider!);
  };

  const readOrders = async (
    provider: ethers.providers.Web3Provider,
    signerAddress: string
  ) => {
    let simpleFeedConsumercontract = await getSimplePriceFeedConsumer(provider);
    let totalOrders = await simpleFeedConsumercontract.priceId();

    const _orders = [];
    for (let i = +totalOrders.toString() - 1; i >= +totalOrders.toString()-5; i--) {
      let orderId = await simpleFeedConsumercontract.prices(i);

      let order: IORDER = {
        orderId: i,
        priceSettled: +orderId["onChain"].toString() / 10 ** 8,
        price: +orderId["offChain"].toString() / 10 ** 8,
      };
      _orders.push(order);
    }
    setOrders(_orders);
  };

  const refresh = async (provider: ethers.providers.Web3Provider) => {
    setProvider(provider);

    const addresses = await provider.listAccounts();

    if (addresses.length > 0) {
      const signer = await provider?.getSigner();
      const signerAddress = (await signer?.getAddress()) as string;
      setSignerAddress(signerAddress);
      setSigner(signer);
      setConnectStatus({
        state: State.success,
        message: "Connection Succeed",
      });
      getPrice(provider, signerAddress);

      readOrders(provider, signerAddress);

      setLoading(false);
    } else {
      setLoading(false);
      setConnectStatus({ state: State.failed, message: "Connection Failed" });
    }
  };

  const getPriceFeedAdapter = async (
    provider: ethers.providers.Web3Provider
  ) => {
    if (priceFeedAdapter == undefined) {
      const signer = await provider?.getSigner();

      const _priceFeed = new ethers.Contract(
        PriceFeedAdapterJson.address,
        PriceFeedAdapterJson.abi,
        signer
      );

      setPriceFeedAdapter(_priceFeed);
      return _priceFeed;
    } else {
      return priceFeedAdapter;
    }
  };

  const getSimplePriceFeedConsumer = async (
    provider: ethers.providers.Web3Provider
  ) => {
    if (simplePriceFeedConsumer == undefined) {
      const signer = await provider?.getSigner();

      const _simplePriceFeedConsumer = new ethers.Contract(
        SimplePriceFeedConsumerJson.address,
        SimplePriceFeedConsumerJson.abi,
        signer
      );

      setSimplePriceFeedConsumer(_simplePriceFeedConsumer);
      return _simplePriceFeedConsumer;
    } else {
      return simplePriceFeedConsumer;
    }
  };

  useEffect(() => {
    (async () => {
      if (provider != null) {
        return;
      }
      if (window.ethereum == undefined) {
        setLoading(false);
      } else {
        const currentChainId = await window.ethereum.request({
          method: "eth_chainId",
        });

        console.log(currentChainId)

        if (currentChainId !== "0x4737") {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x4737" }],
          });
        }
        const web3Provider = new ethers.providers.Web3Provider(window.ethereum);
        setProvider(web3Provider);
      }
    })();
  }, []);

  useEffect(() => {
    const init = async () => {
      if (!provider) {
        return;
      }

      const priceFeedAdapter = await getPriceFeedAdapter(provider);
      /// UI update when metadata update event is  fired (we check if the minted token is ours)
      refresh(provider);
    };
    init();
  }, [provider]);

  return (
    <div className="App">
      <div className="container">
        <Header
          status={connectStatus}
          ready={ready}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          signerAddress={signerAddress}
        />
        {connectStatus?.state! == State.success && (
          <div>
            {loading && <Loading message={message} />}
            <main>
              <div className="flex">
                <div className="isDeployed">
                  <p style={{ fontWeight: "300" }}>
                    {price.price.toFixed(8)}
                    <br></br>
                    <span style={{ fontSize: "14px" }} className="highlight">
                      USDC/XAU
                    </span>
                  </p>
                  <p style={{ fontWeight: "300" }}>
                    User:
                    <span
                      style={{ marginLeft: "10px", fontSize: "15px" }}
                      className="highlight"
                    >
                      {signerAddress?.substring(0, 6) +
                        "..." +
                        signerAddress?.substring(
                          signerAddress?.length - 4,
                          signerAddress?.length
                        )}
                    </span>
                  </p>

                  <p style={{ fontWeight: "300" }}>
                    Total Orders:
                    <span
                      style={{ marginLeft: "10px", fontSize: "15px" }}
                      className="highlight"
                    >
                      {orders.length}
                      <span style={{ position: "relative", top: "5px" }}>
                        <BiRefresh
                          color="white"
                          cursor={"pointer"}
                          fontSize={"20px"}
                          onClick={doRefresh}
                        />
                      </span>
                    </span>
                  </p>
                  <Button onClick={() => onAction(0)}> SetOrder</Button>
                  <p style={{ fontWeight: "300" }}>
                    Showing last 5
              
                  </p>
                  {orders.length > 0 && (
                    <div className="table-master">
                      <div className="table">
                        <p className="table-header table-header-title">
                          {" "}
                          OrderId
                        </p>{" "}
                        <p
                          style={{ width: "150px" }}
                          className="table-header table-header-title"
                        >
                          {" "}
                          Price
                        </p>{" "}
                        <p
                          style={{ width: "150px" }}
                          className="table-header table-header-title"
                        >
                          {" "}
                          PriceSettled
                        </p>
                      </div>
                      {orders.map((val, index) => {
                        return (
                          <div key={index} className="table">
                            <p className="table-header"> {val.orderId}</p>{" "}
                            <p
                              style={{ width: "150px" }}
                              className="table-header"
                            >
                              {" "}
                              {val.price}
                            </p>{" "}
                            <p
                              style={{ width: "150px" }}
                              className="table-header"
                            >
                              {" "}
                              {val.priceSettled}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </main>
          </div>
        )}{" "}
        {connectStatus?.state! == State.missing && (
          <p style={{ textAlign: "center" }}>Metamask not Found</p>
        )}
        {(connectStatus?.state == State.pending ||
          connectStatus?.state == State.failed) && (
          <div style={{ textAlign: "center", marginTop: "20px" }}>
            <h3> Please connect your metamask</h3>
            <Button status={connectStatus} onClick={onConnect}>
              <img src={metamask} width={25} height={25} />{" "}
              <span style={{ position: "relative", top: "-6px" }}>
                Connect{" "}
              </span>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
