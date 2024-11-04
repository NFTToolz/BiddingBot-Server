import express from "express";
import { config } from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import WebSocket, { Server as WebSocketServer } from 'ws';
import http from 'http';
import { initialize } from "./init";
import { bidOnOpensea, cancelOrder, fetchOpenseaListings, fetchOpenseaOffers, IFee } from "./marketplace/opensea";
import { bidOnBlur, cancelBlurBid, fetchBlurBid, fetchBlurCollectionStats } from "./marketplace/blur/bid";
import { bidOnMagiceden, canelMagicEdenBid, fetchMagicEdenCollectionStats, fetchMagicEdenOffer, fetchMagicEdenTokens } from "./marketplace/magiceden";
import { getCollectionDetails, getCollectionStats } from "./functions";
import mongoose from 'mongoose';
import Task from "./models/task.model";
import { Queue, Worker, QueueEvents } from "bullmq";
import Wallet from "./models/wallet.model";
import redisClient from "./utils/redis";
import { WETH_CONTRACT_ADDRESS, WETH_MIN_ABI } from "./constants";
import { constants, Contract, ethers, Wallet as Web3Wallet } from "ethers";

const SEAPORT = '0x1e0049783f008a0085193e00003d00cd54003c71';


const redis = redisClient.getClient()

config()
export const MAGENTA = '\x1b[35m';
export const BLUE = '\x1b[34m';
export const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GOLD = '\x1b[33m';

const OPENSEA = "OPENSEA";
const MAGICEDEN = "MAGICEDEN";
const BLUR = "BLUR";

const currentTasks: ITask[] = [];

const QUEUE_NAME = 'BIDDING_BOT';
const UPDATE_STATUS = "UPDATE_STATUS"

const OPENSEA_SCHEDULE = "OPENSEA_SCHEDULE"
const OPENSEA_TRAIT_BID = "OPENSEA_TRAIT_BID"
const BLUR_TRAIT_BID = "BLUR_TRAIT_BID"
const BLUR_SCHEDULE = "BLUR_SCHEDULE"
const MAGICEDEN_SCHEDULE = "MAGICEDEN_SCHEDULE"
const MAGICEDEN_TOKEN_BID = "MAGICEDEN_TOKEN_BID"
const OPENSEA_TOKEN_BID = "OPENSEA_TOKEN_BID"
const MAGICEDEN_TRAIT_BID = "MAGICEDEN_TRAIT_BID"
const CANCEL_OPENSEA_BID = "CANCEL_OPENSEA_BID"
const CANCEL_MAGICEDEN_BID = "CANCEL_MAGICEDEN_BID"
const CANCEL_BLUR_BID = "CANCEL_BLUR_BID"
const START_TASK = "START_TASK"
const STOP_TASK = "STOP_TASK"
const MAGICEDEN_MARKETPLACE = "0x9A1D00bEd7CD04BCDA516d721A596eb22Aac6834"

const MAX_RETRIES: number = 5;
const MARKETPLACE_WS_URL = "wss://wss-marketplace.nfttools.website";
const ALCHEMY_API_KEY = "0rk2kbu11E5PDyaUqX1JjrNKwG7s4ty5"

const RATE_LIMIT = 30;
const MAX_WAITING_QUEUE = 10 * RATE_LIMIT;
const OPENSEA_PROTOCOL_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395"

const itemLocks = new Map();
const queue = new Queue(QUEUE_NAME);

const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redis
});

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let ws: WebSocket;
let heartbeatIntervalId: NodeJS.Timeout | null = null;
let reconnectTimeoutId: NodeJS.Timeout | null = null;
let retryCount: number = 0;
let waitingQueueCount = 0;

const walletsArr: string[] = []

async function fetchCurrentTasks() {
  try {
    const tasks = await Task.find({}).lean().exec() as unknown as ITask[];
    const wallets = (await Wallet.find({}).lean()).map((wallet: any) => wallet.address);

    walletsArr.push(...wallets);

    const formattedTasks = tasks.map((task) => ({ ...task, _id: task._id.toString(), user: task.user.toString() }));
    const jobs = formattedTasks.flatMap(task =>
      task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: task, opts: { priority: 5 } }] : []
    ).concat(
      formattedTasks.flatMap(task =>
        task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: task, opts: { priority: 5 } }] : []
      )
    ).concat(
      formattedTasks.flatMap(task =>
        task.running && task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: task, opts: { priority: 5 } }] : []
      )
    );

    await queue.addBulk(jobs);
    currentTasks.push(...formattedTasks);

    console.log(`Fetched ${formattedTasks.length} current tasks from the database.`);
  } catch (error) {
    console.error('Error fetching current tasks:', error);
  }
}

async function startServer() {
  try {
    await initialize();
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('Connected to MongoDB');

    server.listen(port, () => {
      console.log(`Magic happening on http://localhost:${port}`);
      console.log(`WebSocket server is running on ws://localhost:${port}`);
    });

    await fetchCurrentTasks();
  } catch (error) {
    console.error(RED + 'Failed to connect to MongoDB:' + RESET, error);
  }
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
});

connectWebSocket()

wss.on('connection', (ws) => {
  console.log(GREEN + 'New WebSocket connection' + RESET);
  ws.onmessage = async (event: WebSocket.MessageEvent) => {
    try {
      const message = JSON.parse(event.data as string);
      switch (message.endpoint) {
        case 'new-task':
          await processNewTask(message.data);
          break;
        case 'updated-task':
          await processUpdatedTask(message.data);
          break;
        case 'toggle-status':
          await updateStatus(message.data);
          break;
        case 'update-multiple-tasks-status':
          await updateMultipleTasksStatus(message.data);
          break;
        case 'update-marketplace':
          await updateMarketplace(message.data)
          break
        default:
          console.warn(YELLOW + `Unknown endpoint: ${message.endpoint}` + RESET);
      }
    } catch (error) {
      console.error(RED + 'Error handling WebSocket message:' + RESET, error);
    }
  };

  ws.onclose = () => {
    console.log(YELLOW + 'WebSocket connection closed' + RESET);
  };
});

const worker = new Worker(QUEUE_NAME, async (job) => {
  const itemId = job.data.itemId;
  await waitForUnlock(itemId, job.name);
  try {
    itemLocks.set(itemId, true);
    switch (job.name) {
      case OPENSEA_SCHEDULE:
        await processOpenseaScheduledBid(job.data)
        break;
      case OPENSEA_TRAIT_BID:
        await processOpenseaTraitBid(job.data)
        break;
      case OPENSEA_TOKEN_BID:
        await processOpenseaTokenBid(job.data)
        break;
      case BLUR_SCHEDULE:
        await processBlurScheduledBid(job.data)
        break;
      case BLUR_TRAIT_BID:
        await processBlurTraitBid(job.data)
        break;
      case MAGICEDEN_SCHEDULE:
        await processMagicedenScheduledBid(job.data)
        break;
      case MAGICEDEN_TRAIT_BID:
        await processMagicedenTraitBid(job.data)
        break;
      case MAGICEDEN_TOKEN_BID:
        await processMagicedenTokenBid(job.data)
        break;
      case UPDATE_STATUS:
        await updateStatus(job.data)
        break
      case START_TASK:
        await startTask(job.data, true)
        break
      case STOP_TASK:
        await stopTask(job.data, false)
        break;

      case CANCEL_OPENSEA_BID:
        await bulkCancelOpenseaBid(job.data)
        break;
      case CANCEL_MAGICEDEN_BID:
        await bulkCancelMagicedenBid(job.data)
        break;
      case CANCEL_BLUR_BID:
        await blukCancelBlurBid(job.data)
        break;
      default:
        console.log(`Unknown job type: ${job.name}`);
    }
  } finally {
    itemLocks.delete(itemId);
  }
},
  {
    connection: redis,
    concurrency: RATE_LIMIT,
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 0 }
  },
);

async function processNewTask(task: ITask) {
  try {
    currentTasks.push(task);
    console.log(GREEN + `Added new task: ${task.contract.slug}` + RESET);
    const jobs = await queue.addBulk([
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: task, opts: { priority: 5 } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: task, opts: { priority: 5 } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: task, opts: { priority: 5 } }] : []),
    ]);
    console.log(`Successfully added ${jobs.length} jobs to the queue.`);
    subscribeToCollections([task]);
  } catch (error) {
    console.error(RED + `Error processing new task: ${task.contract.slug}` + RESET, error);
  }
}

async function processUpdatedTask(task: ITask) {
  try {
    const existingTaskIndex = currentTasks.findIndex(t => t._id === task._id);
    if (existingTaskIndex !== -1) {
      currentTasks.splice(existingTaskIndex, 1, task);
      console.log(YELLOW + `Updated existing task: ${task.contract.slug}` + RESET);
      subscribeToCollections([task]);
    } else {
      console.log(RED + `Attempted to update non-existent task: ${task.contract.slug}` + RESET);
    }
  } catch (error) {
    console.error(RED + `Error processing updated task: ${task.contract.slug}` + RESET, error);
  }
}

async function startTask(task: ITask, start: boolean) {
  try {
    const taskIndex = currentTasks.findIndex(task => task._id === task._id);

    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = start;
    }
    console.log(GREEN + `Updated task ${task.contract.slug} running status to: ${start}`.toUpperCase() + RESET);
    if (task.outbidOptions.counterbid) {
      console.log("subscribing to collection: ", task.contract.slug);
      const newTask = { ...task, running: true }
      subscribeToCollections([newTask]);
    }

    const jobs = [
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("opensea") ? [{ name: OPENSEA_SCHEDULE, data: { ...task, running: start }, opts: { priority: 5 } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("blur") ? [{ name: BLUR_SCHEDULE, data: { ...task, running: start }, opts: { priority: 5 } }] : []),
      ...(task.selectedMarketplaces.map(m => m.toLowerCase()).includes("magiceden") ? [{ name: MAGICEDEN_SCHEDULE, data: { ...task, running: start }, opts: { priority: 5 } }] : []),
    ]

    await queue.addBulk(jobs);
  } catch (error) {
    console.log(error);
  }
}

async function stopTask(task: ITask, start: boolean) {
  try {
    const taskIndex = currentTasks.findIndex(task => task._id === task._id);
    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = start;
    }
    console.log(YELLOW + `Stopped processing task ${task.contract.slug}` + RESET);

    const jobs = await queue.getJobs(['waiting', 'completed', 'failed', "delayed", "paused", "wait", "waiting", "waiting-children", "failed", "prioritized", "repeat"]);

    const activeJobs = await queue.getJobs(['active']);

    const relevantActiveJobs = activeJobs.filter((job) =>
      (job?.data?.slug === task.contract.slug || job?.data?.contract?.slug === task?.contract?.slug) &&
      [OPENSEA_SCHEDULE, BLUR_SCHEDULE, MAGICEDEN_SCHEDULE,
        OPENSEA_TRAIT_BID, MAGICEDEN_TRAIT_BID, BLUR_TRAIT_BID,
        OPENSEA_TOKEN_BID, MAGICEDEN_TOKEN_BID].includes(job.name)
    );

    if (!jobs.length || relevantActiveJobs.length) return

    if (relevantActiveJobs.length > 0) {
      console.log(YELLOW + `Stopping ${relevantActiveJobs.length} active jobs for ${task.contract.slug}` + RESET);

      await Promise.all(relevantActiveJobs.map(job =>
        Promise.race([
          job.waitUntilFinished(queueEvents, 30000), // 3 second timeout
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Job timeout')), 30000)
          )
        ]).catch(error => {
          console.log(YELLOW + `Job ${job.id} timed out or failed: ${error.message}` + RESET);
          return job.remove();
        })
      ));
    }

    const stoppedJob = jobs?.filter((job) => job?.data?.slug === task.contract.slug || job?.data?.contract?.slug === task?.contract?.slug)

    await Promise.all(stoppedJob.map(job => job.remove()));

    let openseaBids: string[] = []
    let magicedenBids: string[] = []
    let blurBids: string[] = []

    const selectedTraits = transformNewTask(task.selectedTraits)

    async function cancelBidsRecursively(): Promise<void> {
      // Get current bids
      if (task.bidType === "token") {
        openseaBids = await redis.keys(`*:opensea:order:${task.contract.slug}:[0-9]*`);
        magicedenBids = await redis.keys(`*:magiceden:order:${task.contract.slug}:[0-9]*`);
        blurBids = await redis.keys(`*:blur:order:${task.contract.slug}:[0-9]*`)
      } else if (task.bidType === "collection" && (!selectedTraits || (selectedTraits && Object.keys(selectedTraits).length === 0))) {
        openseaBids = await redis.keys(`*:opensea:order:${task.contract.slug}:default`);
        magicedenBids = await redis.keys(`*:magiceden:order:${task.contract.slug}:default`);
        blurBids = await redis.keys(`*:blur:order:${task.contract.slug}:default`)
      } else {
        openseaBids = await redis.keys(`*:opensea:order:${task.contract.slug}:*`);
        magicedenBids = await redis.keys(`*:magiceden:order:${task.contract.slug}:*`);
        blurBids = await redis.keys(`*:blur:order:${task.contract.slug}:*`)
      }

      // If no bids remain, we're done
      if (!openseaBids.length && !magicedenBids.length && !blurBids.length) {
        console.log(GREEN + `Successfully cancelled all bids for ${task.contract.slug}` + RESET);
        return;
      }

      // Process current batch of bids
      const openseaBidData = await Promise.all(openseaBids.map(key => redis.get(key)));
      const cancelData = openseaBidData.map(bid => ({
        name: CANCEL_OPENSEA_BID,
        data: { orderHash: bid, privateKey: task.wallet.privateKey },
        opts: { priority: 1 }
      }));

      const magicedenBidData = await Promise.all(magicedenBids.map(key => redis.get(key)));
      const parsedMagicedenBid = magicedenBidData
        .filter(data => data !== null)
        .map((data) => JSON.parse(data))
        .filter((data) => data?.message?.toLowerCase() === "success")
        .map((data) => data.orderId)
        .filter(id => id !== undefined);

      const collectionIds = magicedenBidData
        ?.filter(data => data !== null)
        ?.map(data => {
          const parsedData = JSON.parse(data);
          return parsedData.results?.map((result: any) => result?.orderId);
        }).flat()
        .filter(id => id !== undefined);

      const orderIds = [...collectionIds, ...parsedMagicedenBid].filter(id => id !== undefined);

      const blurBidData = await Promise.all(blurBids.map(key => redis.get(key)));
      const parsedBlurBid = blurBidData
        .filter(data => data !== null)
        .map((data) => JSON.parse(data))

      const blurCancelData = parsedBlurBid.map((bid) => ({
        name: CANCEL_BLUR_BID,
        data: { payload: bid, privateKey: task.wallet.privateKey },
        opts: { priority: 1 }
      }));

      // Add cancel jobs to queue
      if (cancelData.length) await queue.addBulk(cancelData);
      if (orderIds.length) await queue.add(CANCEL_MAGICEDEN_BID, { orderIds, privateKey: task.wallet.privateKey }, { priority: 1 });
      if (blurCancelData.length) await queue.addBulk(blurCancelData);

      // Delete processed keys
      await Promise.all(openseaBids.map(key => redis.del(key)));
      await Promise.all(magicedenBids.map(key => redis.del(key)));
      await Promise.all(blurBids.map(key => redis.del(key)));

      // Log progress
      const count = parsedMagicedenBid.length + cancelData.length + blurCancelData.length;
      console.log(YELLOW + `Processed ${count} bid cancellations for ${task.contract.slug}. Checking for remaining bids...` + RESET);

      // Wait a short time before next iteration to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Recursively check for more bids
      await cancelBidsRecursively();
    }

    // Start the recursive cancellation process
    await cancelBidsRecursively();

    if (task.outbidOptions.counterbid) {
      unsubscribeFromCollection(task);
    }
  } catch (error) {
    console.log(error);
  }
}

async function updateStatus(task: ITask) {
  try {
    const { _id: taskId, running } = task;
    const taskIndex = currentTasks.findIndex(task => task._id === taskId);
    const start = !running;
    if (taskIndex !== -1) {
      currentTasks[taskIndex].running = start;
      if (start) {
        await startTask(task, true)
      } else {
        await stopTask(task, false)
      }
    }
  } catch (error) {
    console.error(RED + `Error updating status for task: ${task._id}` + RESET, error);
  }
}

function unsubscribeFromCollection(task: ITask) {
  if (ws.readyState === WebSocket.OPEN) { // Check if WebSocket is open
    const unsubscribeMessage = {
      "slug": task.contract.slug,
      "topic": task.contract.slug,
      "contractAddress": task.contract.contractAddress,
      "event": "leave_the_party",
      "clientId": task.user.toString(),
    };
    ws.send(JSON.stringify(unsubscribeMessage));
    console.log(`Unsubscribed from collection: ${task.contract.slug}`);
  } else {
    console.error(`WebSocket is not open for unsubscribing from collection: ${task.contract.slug}`);
  }
}

async function updateMarketplace(task: ITask) {
  try {
    const { _id: taskId, selectedMarketplaces } = task;
    const taskIndex = currentTasks?.findIndex(task => task?._id === taskId);
    const current = currentTasks[taskIndex]?.selectedMarketplaces;
    const loopIntervalMs = getExpiry(task?.loopInterval) * 1000; // Convert to milliseconds
    const jobOptions = loopIntervalMs > 0 ? { repeat: { every: loopIntervalMs } } : {};

    const outgoing = current?.filter(marketplace => !selectedMarketplaces?.includes(marketplace));
    const jobs = await queue?.getJobs(['waiting', 'completed', 'failed', "delayed", "paused"]);
    const selectedJobs = jobs?.filter((job) => job?.data?.slug === task?.contract?.slug || job?.data?.contract?.slug === task?.contract?.slug);
    const incoming = selectedMarketplaces?.filter(marketplace => !current.includes(marketplace));

    if (outgoing?.map((marketplace) => marketplace?.toLowerCase())?.includes("opensea")) {
      const openseaJobs = selectedJobs?.filter((job) => job?.name === OPENSEA_SCHEDULE || job?.name === OPENSEA_TRAIT_BID || job?.name === OPENSEA_TOKEN_BID)
      await Promise.all(openseaJobs?.map(job => job.remove()));

      console.log(RED + `STOPPING ALL WAITING, DELAYED OR PAUSED OPENSEA JOBS FOR ${task.contract.slug}` + RESET);

      const openseaBids = await redis.keys(`*:opensea:order:${task.contract.slug}:*`);
      const openseaBidData = await Promise.all(openseaBids?.map(key => redis.get(key)));
      const cancelData = openseaBidData?.map(bid => ({ name: CANCEL_OPENSEA_BID, data: { orderHash: bid, privateKey: task.wallet.privateKey, opts: { priority: 1 } } }));
      await queue.addBulk(cancelData);
      console.log(RED + `CANCELLING ALL ACTIVE OPENSEA BIDS ${task.contract.slug}` + RESET);


      await Promise.all(openseaBids.map(key => redis.del(key)));

    }

    if (outgoing?.map((marketplace) => marketplace?.toLowerCase())?.includes("blur")) {
      const blurJobs = selectedJobs?.filter((job) => job?.name === BLUR_SCHEDULE || job?.name === BLUR_TRAIT_BID)
      await Promise.all(blurJobs?.map(job => job.remove()));

      console.log(RED + `STOPPING ALL WAITING, DELAYED OR PAUSED BLUR JOBS ${task?.contract?.slug}` + RESET);

      const blurBids = await redis.keys(`*:blur:order:${task?.contract?.slug}:*`)
      const blurBidData = await Promise.all(blurBids.map(key => redis.get(key)));
      const parsedBlurBid = blurBidData
        ?.filter(data => data !== null) // Ensure data is not null
        ?.map((data) => JSON.parse(data))

      const blurCancelData = parsedBlurBid?.map((bid) => ({ name: CANCEL_BLUR_BID, data: { payload: bid, privateKey: task.wallet.privateKey }, opts: { priority: 1 } }))
      await queue.addBulk(blurCancelData)
      console.log(RED + `CANCELLING ALL ACTIVE BLUR BIDS ${task?.contract?.slug}` + RESET);
      await Promise.all(blurBids.map(key => redis.del(key)));
    }

    if (outgoing?.map((marketplace) => marketplace?.toLowerCase())?.includes("magiceden")) {
      const magicedenJobs = selectedJobs?.filter((job) => job?.name === MAGICEDEN_SCHEDULE || job?.name === MAGICEDEN_TRAIT_BID || job?.name === MAGICEDEN_TOKEN_BID)
      await Promise.all(magicedenJobs?.map(job => job.remove()));

      console.log(RED + `STOPPING ALL WAITING, DELAYED OR PAUSED MAGICEDEN JOBS FOR ${task.contract.slug}` + RESET);

      const magicedenBids = await redis.keys(`*:magiceden:order:${task.contract.slug}:*`);
      const magicedenBidData = await Promise.all(magicedenBids.map(key => redis.get(key)));
      const parsedMagicedenBid = magicedenBidData
        ?.filter(data => data !== null) // Ensure data is not null
        ?.map((data) => JSON.parse(data))
        ?.filter((data) => data?.message?.toLowerCase() === "success")
        ?.map((data) => data.orderId)

      queue.add(CANCEL_MAGICEDEN_BID, { orderIds: parsedMagicedenBid, privateKey: task.wallet.privateKey }, { priority: 1 })
      console.log(RED + `CANCELLING ALL ACTIVE MAGICEDEN BIDS FOR ${task.contract.slug}` + RESET);
      await Promise.all(magicedenBids.map(key => redis.del(key)));
    }

    if (incoming.map((marketplace) => marketplace.toLowerCase()).includes("opensea")) {
      queue.add(OPENSEA_SCHEDULE, task, { priority: 5 })
    }

    if (incoming.map((marketplace) => marketplace.toLowerCase()).includes("magiceden")) {
      queue.add(MAGICEDEN_SCHEDULE, task, { priority: 5 })
    }

    if (incoming.map((marketplace) => marketplace.toLowerCase()).includes("blur")) {
      queue.add(BLUR_SCHEDULE, task, { priority: 5 })
    }

    if (taskIndex !== -1) {
      currentTasks[taskIndex].selectedMarketplaces = selectedMarketplaces;
    }

  } catch (error) {
    console.error(RED + `Error updating marketplace for task: ${task._id}` + RESET, error);
  }
}

async function updateMultipleTasksStatus(data: { tasks: ITask[], running: boolean }) {
  try {
    const { tasks, running } = data;
    if (running) {
      const jobs = tasks.map((task) => ({
        name: START_TASK, data: task, opts: { priority: 3 }
      }))
      await queue.addBulk(jobs)
    } else {
      const jobs = tasks.map((task) => ({ name: STOP_TASK, data: task, opts: { priority: 1 } }))
      await queue.addBulk(jobs)
    }
  } catch (error) {
    console.log(error);
  }
}


function connectWebSocket(): void {

  ws = new WebSocket(MARKETPLACE_WS_URL);
  ws.addEventListener("open", function open() {
    console.log(GOLD + "CONNECTED TO MARKETPLACE EVENTS WEBSCKET" + RESET);
    retryCount = 0;
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
    }

    const task = currentTasks[0]
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: "ping",
            "clientId": task.user.toString() || "nfttools to the moon",
          })
        );
      }
    }, 30000);


    if (currentTasks.length > 0) {
      subscribeToCollections(currentTasks as unknown as ITask[])
    }

    ws.on("message", async function incoming(data: string) {
      try {
        const message = JSON.parse(data.toString())
        await handleCounterBid(message);
      } catch (error) {
        console.log(error);
      }
    });
  });

  ws.addEventListener("close", function close() {
    console.log(RED + "DISCONNECTED FROM MARKETPLACE EVENTS WEBSCKET" + RESET);
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    attemptReconnect();
  });

  ws.addEventListener("error", function error(err) {
    if (ws) {
      ws.close();
    }
  });
}

function attemptReconnect(): void {
  if (retryCount < MAX_RETRIES) {
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
    }
    let delay: number = Math.pow(2, retryCount) * 1000;
    console.log(`Attempting to reconnect in ${delay / 1000} seconds...`);
    reconnectTimeoutId = setTimeout(connectWebSocket, delay);
    retryCount++;
  } else {
    console.log("Max retries reached. Giving up on reconnecting.");
  }
}

async function handleCounterBid(message: any) {
  const { contractAddress, slug } = getMarketplaceDetails(message);

  if (!contractAddress && !slug) return;

  const relevantTasks = currentTasks.filter(task =>
    task.outbidOptions.counterbid &&
    task.running &&
    (task.contract.contractAddress.toLowerCase() === contractAddress?.toLowerCase() ||
      task.contract.slug.toLowerCase() === slug?.toLowerCase())
  );

  if (!relevantTasks.length) return;

  await Promise.all(relevantTasks.map(task => handleCounterBidForTask(task, message)));
}

function getMarketplaceDetails(message: any): { contractAddress?: string, slug?: string } {
  switch (message.marketplace) {
    case BLUR:
      return { contractAddress: handleBlurMessages(message) };
    case OPENSEA:
      return handleOpenSeaMessages(message);
    case MAGICEDEN:
      return handleMagicEdenMessages(message);
    default:
      console.log(`Unknown marketplace: ${message.marketplace}`);
      return {};
  }
}

async function handleCounterBidForTask(task: any, message: any) {
  const selectedMarketplaces = task.selectedMarketplaces.map((m: string) => m.toLowerCase());

  if (selectedMarketplaces.includes('blur') && message.marketplace === BLUR) {
    await handleBlurCounterbid(message['1'], task);
  }

  if (selectedMarketplaces.includes('opensea') && message.marketplace === OPENSEA) {
    await handleOpenseaCounterbid(message, task);
  }

  if (selectedMarketplaces.includes('magiceden') && message.marketplace === MAGICEDEN) {
    await handleMagicEdenCounterbid(message, task)
  }
}


async function handleMagicEdenCounterbid(data: any, task: ITask) {
  try {

    const domain: string = data?.data?.source?.domain
    if (!domain.includes("magiceden")) return

    const maker = data?.data?.maker?.toLowerCase()
    // if (maker === task.wallet.address.toLowerCase()) return

    const expiry = getExpiry(task.bidDuration)
    const duration = expiry / 60 || 15; // minutes
    const currentTime = new Date().getTime();
    const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);
    const floor_price = await fetchMagicEdenCollectionStats(task.contract.contractAddress)

    if (floor_price === 0 || !floor_price) return

    const { maxBidPriceEth } = calculateBidPrice(task, floor_price as number, "magiceden")
    const magicedenOutbidMargin = task.outbidOptions.magicedenOutbidMargin || 0.0001

    const bidType = data?.data?.criteria?.kind
    const tokenId = +data?.data?.criteria?.data?.token?.tokenId;

    let redisKey: string;
    let currentBidPrice: number | string;
    const incomingPrice = Number(data?.data?.price?.amount?.raw);
    let offerPrice: number;

    const selectedTraits = transformNewTask(task.selectedTraits)


    if (bidType === "token") {
      console.log(BLUE + '----------------------------------------------------------------------------------' + RESET);
      console.log(BLUE + `incoming bid for ${task.contract.slug}:${tokenId} for ${incomingPrice / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(BLUE + '----------------------------------------------------------------------------------' + RESET);

      console.log(BLUE + JSON.stringify(data) + RESET);

      const autoIds = task.tokenIds
        .filter(id => id.toString().toLowerCase().startsWith('bot'))
        .map(id => {
          const matches = id.toString().match(/\d+/);
          return matches ? parseInt(matches[0]) : null;
        })
        .filter(id => id !== null);

      if (!autoIds.includes(tokenId)) return

      redisKey = `magiceden:${task.contract.slug}:${tokenId}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)


      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `magiceden counter offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${tokenId}  exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming magiceden offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} ${tokenId} for ${Number(offerPrice) / 1e18} WETH ON MAGICEDEN`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);

      await processMagicedenTokenBid({
        address: task.wallet.address,
        contractAddress: task.contract.contractAddress,
        quantity: 1,
        offerPrice: offerPrice.toString(),
        expiration: expiration.toString(),
        privateKey: task.wallet.privateKey,
        slug: task.contract.slug,
        tokenId: tokenId,
        outbidOptions: task.outbidOptions,
        maxBidPriceEth
      })
    }
    if (bidType === "attribute") {

      const traitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const trait = {
        attributeKey: data?.data?.criteria?.data?.attribute?.key,
        attributeValue: data?.data?.criteria?.data?.attribute?.value,
      }

      const hasTraits = checkMagicEdenTrait(selectedTraits, trait)
      if (!hasTraits || !traitBid) return

      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `incoming bid for ${task.contract.slug}:${JSON.stringify(trait)} for ${incomingPrice / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);

      redisKey = `magiceden:${task.contract.slug}:${trait}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingPrice)
      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${trait} exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} ${JSON.stringify(trait)} for ${Number(offerPrice) / 1e18} WETH ON MAGICEDEN `.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);

      await processMagicedenTraitBid({
        address: task.wallet.address,
        contractAddress: task.contract.contractAddress,
        quantity: 1,
        offerPrice: offerPrice.toString(),
        expiration: expiration.toString(),
        privateKey: task.wallet.privateKey,
        slug: task.contract.slug,
        trait: trait
      })
    }
    if (bidType === "collection") {
      console.log(GOLD + JSON.stringify(data) + RESET);
      // if (maker === task.wallet.address.toLowerCase()) return

      const isTraitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const tokenBid = task.bidType === "token" && task.tokenIds.length > 0
      const collectionBid = !isTraitBid && !tokenBid

      if (!collectionBid) return

      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `incoming collection offer for ${task.contract.slug} for ${incomingPrice / 1e18} WETH on magiceden`.toUpperCase() + RESET);
      console.log(GREEN + '----------------------------------------------------------------------------------' + RESET);

      redisKey = `magiceden:${task.contract.slug}:collection`;
      currentBidPrice = await redis.get(redisKey) || 0

      currentBidPrice = Number(currentBidPrice)
      if (incomingPrice < currentBidPrice) return
      offerPrice = Math.ceil((magicedenOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug}  exceeds max bid price ${maxBidPriceEth} WETH. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming magiceden offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} for ${Number(offerPrice) / 1e18} WETH`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);

      const bidCount = await getIncrementedBidCount(MAGICEDEN, task.contract.slug)
      await bidOnMagiceden(bidCount, task.wallet.address, task.contract.contractAddress, 1, offerPrice.toString(), expiration.toString(), task.wallet.privateKey, task.contract.slug);
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
  } catch (error) {
    console.error(RED + `Error handling MAGICEDEN counterbid: ${JSON.stringify(error)}` + RESET);
  }
}

async function handleOpenseaCounterbid(data: any, task: ITask) {
  try {
    const maker = data?.payload?.payload?.maker?.address.toLowerCase()
    const incomingPrice: number = Number(data?.payload?.payload?.base_price);

    // if (maker === task.wallet.address.toLowerCase()) return

    const expiry = getExpiry(task.bidDuration)
    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats.total.floor_price;

    if (floor_price === 0) return

    const { maxBidPriceEth } = calculateBidPrice(task, floor_price, "opensea")
    const openseaOutbidMargin = task.outbidOptions.openseaOutbidMargin || 0.0001

    const collectionDetails = await getCollectionDetails(task.contract.slug);
    const creatorFees: IFee = collectionDetails.creator_fees.null !== undefined
      ? { null: collectionDetails.creator_fees.null }
      : Object.fromEntries(Object.entries(collectionDetails.creator_fees).map(([key, value]) => [key, Number(value)]));


    let redisKey: string;
    let currentBidPrice: number | string;
    let offerPrice: number;
    let colletionOffer: bigint;

    const selectedTraits = transformNewTask(task.selectedTraits)

    if (data.event === "item_received_bid") {
      const tokenId = +data.payload.payload.protocol_data.parameters.consideration.find((item: any) => item.token.toLowerCase() === task.contract.contractAddress.toLowerCase()).identifierOrCriteria
      const tokenIds = task.tokenIds.filter(id => id.toString().toLowerCase().startsWith('bot'));

      if (!tokenIds.includes(tokenId)) return

      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);
      console.log(BLUE + `incoming offer for ${task.contract.slug}:${tokenId} for ${incomingPrice / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(BLUE + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:${tokenId}`;

      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)
      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter offer ${offerPrice / 1e18} WETH for ${task.contract.slug}:${tokenId}  exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)

      const asset = {
        contractAddress: task.contract.contractAddress,
        tokenId: tokenId
      }

      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug)
      await bidOnOpensea(
        bidCount,
        task.wallet.address,
        task.wallet.privateKey,
        task.contract.slug,
        colletionOffer,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry,
        undefined,
        asset
      )
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, colletionOffer.toString());

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming opensea offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug}:${asset.tokenId} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
    }
    if (data.event === "trait_offer") {
      const traitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const hasTraits = checkOpenseaTrait(selectedTraits, data.payload.payload.trait_criteria)

      if (!hasTraits || !traitBid) return

      const trait = JSON.stringify({
        type: data.payload.payload.trait_criteria.trait_type,
        value: data.payload.payload.trait_criteria.trait_name
      })

      console.log(GREEN + '---------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `incoming offer for ${task.contract.slug}:${trait} for ${incomingPrice / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(GREEN + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:${trait}`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingPrice < currentBidPrice) return

      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer ${offerPrice / 1e18} WETH for ${task.contract.slug} ${trait}  exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)
      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug)
      await bidOnOpensea(
        bidCount,
        task.wallet.address,
        task.wallet.privateKey,
        task.contract.slug,
        colletionOffer,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry,
        trait
      );
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming opensea offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} ${trait} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
    if (data.event === "collection_offer") {

      const isTraitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
      const tokenBid = task.bidType === "token" && task.tokenIds.length > 0
      const collectionBid = !isTraitBid && !tokenBid

      if (!collectionBid) return

      console.log(GOLD + '---------------------------------------------------------------------------------' + RESET);
      console.log(GOLD + `incoming collection offer for ${task.contract.slug} for ${incomingPrice / 1e18} WETH on opensea`.toUpperCase() + RESET);
      console.log(GOLD + '---------------------------------------------------------------------------------' + RESET);

      redisKey = `opensea:${task.contract.slug}:collection`;
      currentBidPrice = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice)

      if (incomingPrice < currentBidPrice) return
      offerPrice = Math.ceil((openseaOutbidMargin * 1e18) + incomingPrice)

      if (maxBidPriceEth > 0 && Number(offerPrice / 1e18) > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer price ${offerPrice / 1e18} WETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} WETH ON OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }
      colletionOffer = BigInt(offerPrice)
      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug)

      await bidOnOpensea(
        bidCount,
        task.wallet.address,
        task.wallet.privateKey,
        task.contract.slug,
        colletionOffer,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry,
      );

      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(GREEN + `Counterbidding incoming offer of ${Number(incomingPrice) / 1e18} WETH for ${task.contract.slug} for ${Number(colletionOffer) / 1e18} WETH ON OPENSEA`.toUpperCase() + RESET);
      console.log(GREEN + '-------------------------------------------------------------------------------------------------------------------------' + RESET);
    }
  } catch (error) {
    console.error(RED + `Error handling OPENSEA counterbid: ${JSON.stringify(error)}` + RESET);
  }
}

async function handleBlurCounterbid(data: any, task: ITask) {
  const incomingBid: CombinedBid = data
  console.log(GOLD + JSON.stringify(data) + RESET);
  try {
    const expiry = getExpiry(task.bidDuration)
    const floor_price = await fetchBlurCollectionStats(task.contract.slug)

    if (floor_price === 0) return

    const { maxBidPriceEth } = calculateBidPrice(task, floor_price, "blur")

    const selectedTraits = transformNewTask(task.selectedTraits)

    const traitBid = task.bidType === "collection" && selectedTraits && Object.keys(selectedTraits).length > 0
    const blurOutbidMargin = task.outbidOptions.blurOutbidMargin || 0.01

    if (traitBid) {
      const traits = transformBlurTraits(selectedTraits)
      const incomingTraitBids = incomingBid?.stats?.filter(item => item.criteriaType.toLowerCase() === "trait") || incomingBid?.updates?.filter(item => item.criteriaType.toLowerCase() === "trait")
      const hasMatchingTraits = checkBlurTraits(incomingTraitBids, traits);

      if (!hasMatchingTraits.length) return
      for (const traitBid of hasMatchingTraits) {
        const trait = JSON.stringify(traitBid.criteriaValue)
        const redisKey = `blur:${task.contract.slug}:${trait}`;
        let currentBidPrice: string | number = await redis.get(redisKey) || 0
        currentBidPrice = Number(currentBidPrice) / 1e18
        if (!currentBidPrice) return
        const incomingPrice = Number(traitBid.bestPrice)
        if (incomingPrice <= currentBidPrice) return
        const offerPrice = Math.ceil(blurOutbidMargin + Number(incomingPrice))

        if (offerPrice > maxBidPriceEth) {
          console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
          console.log(RED + `counter Offer price ${offerPrice} BETH exceeds max bid price ${maxBidPriceEth} BETH ON BLUR. Skipping ...`.toUpperCase() + RESET);
          console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
          return;
        }

        await processBlurTraitBid({
          contractAddress: task.contract.contractAddress,
          privateKey: task.wallet.privateKey,
          address: task.wallet.address,
          offerPrice: offerPrice.toString(),
          slug: task.contract.slug,
          trait: JSON.stringify(trait),
          expiry: expiry,
          outbidOptions: task.outbidOptions,
          maxBidPriceEth: maxBidPriceEth
        })
      }

    } else {
      const incomingPrice = incomingBid?.stats ?
        +incomingBid?.stats?.filter(item => item.criteriaType.toLowerCase() === "collection").sort((a, b) => +b.bestPrice - +a.bestPrice)[0].bestPrice
        : +incomingBid?.updates?.filter(item => item.criteriaType.toLowerCase() === "collection").sort((a, b) => +b.price - +a.price)[0].price

      const redisKey = `blur:${task.contract.slug}:collection`;
      let currentBidPrice: string | number = await redis.get(redisKey) || 0
      currentBidPrice = Number(currentBidPrice) / 1e18
      if (!currentBidPrice) return

      if (incomingPrice <= currentBidPrice) return

      const offerPrice = BigInt(Math.ceil(blurOutbidMargin + Number(incomingPrice) * 1e18))

      if (maxBidPriceEth > 0 && offerPrice > maxBidPriceEth) {
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `counter Offer price ${offerPrice} BETH exceeds max bid price ${maxBidPriceEth} BETH ON BLUR. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
        return;
      }

      const bidCount = await getIncrementedBidCount(BLUR, task.contract.slug)
      await bidOnBlur(bidCount, task.wallet.address, task.wallet.privateKey, task.contract.contractAddress, offerPrice, task.contract.slug, expiry);
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }

  } catch (error) {
    console.error(RED + `Error handling Blur counterbid: ${JSON.stringify(error)}` + RESET);
  }
}

function handleMagicEdenMessages(message: any) {
  let slug, contractAddress;
  try {
    if (
      typeof message === "object" && message.event === "bid.created"
    ) {
      slug = message.payload?.payload?.collection?.slug;
      contractAddress = message.tags?.contract || message.payload?.payload?.asset_contract_criteria?.address;
    }
  } catch (error) {
    console.error("Error parsing MagicEden message:", error);
  }
  return { contractAddress, slug }
}

function handleOpenSeaMessages(message: any) {
  let contractAddress, slug

  try {
    if (
      typeof message === "object" &&
      (message.event === "item_received_bid" ||
        message.event === "trait_offer" ||
        message.event === "collection_offer"
      )
    ) {
      slug = message.payload?.payload?.collection?.slug;
      contractAddress = message.payload?.payload?.asset_contract_criteria?.address;
    }
  } catch (err) {
    console.error("Error parsing OpenSea message:", err);
  }
  return { contractAddress, slug }
}

function handleBlurMessages(message: any) {
  let contractAddress: string | undefined;
  try {
    contractAddress = message['1'].contractAddress;
  } catch (error) {
    console.error(`Failed to parse Blur message:`, error);
  }
  return contractAddress
}

async function processOpenseaScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("opensea")) return

    const filteredTasks = Object.fromEntries(
      Object.entries(task?.selectedTraits || {}).map(([category, traits]) => [
        category,

        traits.filter(trait => trait.availableInMarketplaces.includes("opensea"))
      ]).filter(([_, traits]) => traits.length > 0)
    );

    const selectedTraits = transformNewTask(filteredTasks)
    const expiry = getExpiry(task.bidDuration)
    const WALLET_ADDRESS: string = task.wallet.address;
    const WALLET_PRIVATE_KEY: string = task.wallet.privateKey;
    const collectionDetails = await getCollectionDetails(task.contract.slug);
    const traitBid = selectedTraits && Object.keys(selectedTraits).length > 0

    const stats = await getCollectionStats(task.contract.slug);
    const floor_price = stats?.total?.floor_price || 0;


    const autoIds = task.tokenIds
      .filter(id => id.toString().toLowerCase().startsWith('bot'))
      .map(id => {
        const matches = id.toString().match(/\d+/);
        return matches ? parseInt(matches[0]) : null;
      })
      .filter(id => id !== null);

    const bottlomListing = await fetchOpenseaListings(task.contract.slug, autoIds[0])
    const taskTokenIds = task.tokenIds

    const tokenIds = [...bottlomListing, ...taskTokenIds]

    const tokenBid = task.bidType === "token" && tokenIds.length > 0

    if (floor_price === 0) return

    console.log(BLUE + `Current OPENSEA floor price for ${task.contract.slug}: ${floor_price} ETH`.toUpperCase() + RESET);

    const { offerPriceEth, maxBidPriceEth } = calculateBidPrice(task, floor_price, "opensea")

    const approved = await approveMarketplace(WETH_CONTRACT_ADDRESS, SEAPORT, task, maxBidPriceEth);

    if (!approved) return

    let offerPrice = BigInt(Math.ceil(offerPriceEth * 1e18));
    const creatorFees: IFee = collectionDetails.creator_fees.null !== undefined
      ? { null: collectionDetails.creator_fees.null }
      : Object.fromEntries(Object.entries(collectionDetails.creator_fees).map(([key, value]) => [key, Number(value)]));



    if (tokenBid) {
      const jobs = tokenIds
        .filter(token => !isNaN(Number(token))) // Filter out non-numeric tokens
        .map((token) => ({
          name: OPENSEA_TOKEN_BID,
          data: {
            address: WALLET_ADDRESS,
            privateKey: WALLET_PRIVATE_KEY,
            slug: task.contract.slug,
            offerPrice: offerPrice.toString(),
            creatorFees,
            enforceCreatorFee: collectionDetails.enforceCreatorFee,
            asset: { contractAddress: task.contract.contractAddress, tokenId: token },
            expiry,
            outbidOptions: task.outbidOptions,
            maxBidPriceEth: maxBidPriceEth
          },
          opts: { priority: 5 }
        }))
      await queue.addBulk(jobs)
    } else if (traitBid && collectionDetails.trait_offers_enabled) {
      const traits = transformOpenseaTraits(selectedTraits);
      const traitJobs = traits.map((trait) => ({
        name: OPENSEA_TRAIT_BID,
        data: {
          address: WALLET_ADDRESS,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          contractAddress: task.contract.contractAddress,
          offerPrice: offerPrice.toString(),
          creatorFees,
          enforceCreatorFee: collectionDetails.enforceCreatorFee,
          trait: JSON.stringify(trait),
          expiry,
          outbidOptions: task.outbidOptions,
          maxBidPriceEth: maxBidPriceEth
        },
        opts: { priority: 5 }
      }))
      const jobs = await queue.addBulk(traitJobs)
      console.log(`ADDED ${jobs.length} ${task.contract.slug} OPENSEA TRAIT BID JOBS TO QUEUE`);
    } else {
      if (task.outbidOptions.outbid) {
        let highestBids = await fetchOpenseaOffers(task.wallet.address, "COLLECTION", task.contract.slug, task.contract.contractAddress, {})
        highestBids = Number(highestBids)
        const outbidMargin = (task.outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
        const bidPrice = !highestBids ? Number(offerPrice) : highestBids + outbidMargin
        offerPrice = BigInt(Math.ceil(bidPrice))
      }
      if (maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {
        console.log("wagwan");

        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `Offer price ${Number(offerPrice) / 1e18} ETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        return
      }

      const redisKey = `opensea:${task.contract.slug}:collection`;
      const bidCount = await getIncrementedBidCount(OPENSEA, task.contract.slug)
      await bidOnOpensea(
        bidCount,
        WALLET_ADDRESS,
        WALLET_PRIVATE_KEY,
        task.contract.slug,
        offerPrice,
        creatorFees,
        collectionDetails.enforceCreatorFee,
        expiry
      );
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
  } catch (error) {
    console.error(RED + `Error processing OpenSea scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processBlurScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("blur")) return

    const filteredTasks = Object.fromEntries(
      Object.entries(task?.selectedTraits || {}).map(([category, traits]) => [
        category,
        traits.filter(trait => trait.availableInMarketplaces.includes("blur"))
      ]).filter(([_, traits]) => traits.length > 0)
    );

    const expiry = getExpiry(task.bidDuration)
    const WALLET_ADDRESS: string = task.wallet.address;
    const WALLET_PRIVATE_KEY: string = task.wallet.privateKey;
    const selectedTraits = transformNewTask(filteredTasks)

    const traitBid = selectedTraits && Object.keys(selectedTraits).length > 0
    const outbidMargin = task.outbidOptions.blurOutbidMargin || 0.01
    const floor_price = await fetchBlurCollectionStats(task.contract.slug)

    if (floor_price === 0) return

    console.log(GOLD + `Current BLUR floor price for ${task.contract.slug}: ${floor_price} ETH`.toUpperCase() + RESET);

    const { offerPriceEth, maxBidPriceEth } = calculateBidPrice(task, floor_price, "blur")

    let offerPrice = BigInt(Math.ceil(offerPriceEth * 1e18));
    const contractAddress = task.contract.contractAddress

    if (traitBid) {
      const traits = transformBlurTraits(selectedTraits)
      const traitJobs = traits.map((trait) => ({
        name: BLUR_TRAIT_BID,
        data: {
          address: WALLET_ADDRESS,
          privateKey: WALLET_PRIVATE_KEY,
          contractAddress,
          offerPrice: offerPrice.toString(),
          slug: task.contract.slug,
          trait: JSON.stringify(trait),
          expiry,
          outbidOptions: task.outbidOptions,
          maxBidPriceEth: maxBidPriceEth
        },
        opts: { priority: 5 }
      }))

      const jobs = await queue.addBulk(traitJobs)
      console.log(`ADDED ${jobs.length} ${task.contract.slug} BLUR TRAIT BID JOBS TO QUEUE`);
    } else {

      if (task.outbidOptions.outbid) {
        const bids = await fetchBlurBid(task.contract.slug, "COLLECTION", {})
        const highestBids = Number(bids?.priceLevels.sort((a, b) => +b.price - +a.price)[0].price)
        const bidPrice = highestBids + outbidMargin
        offerPrice = BigInt(Math.ceil(Number(bidPrice) * 1e18))
      }

      if (maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `Offer price ${Number(offerPrice) / 1e18} ETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} ETH FOR BLUR. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        return
      }

      const bidCount = await getIncrementedBidCount(BLUR, task.contract.slug)
      await bidOnBlur(bidCount, WALLET_ADDRESS, WALLET_PRIVATE_KEY, contractAddress, offerPrice, task.contract.slug, expiry);
      const redisKey = `blur:${task.contract.slug}:collection`;
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
  } catch (error) {
    console.error(RED + `Error processing Blur scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processOpenseaTraitBid(data: {
  address: string;
  privateKey: string;
  slug: string;
  contractAddress: string;
  offerPrice: string;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  trait: string;
  expiry: number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  }
  maxBidPriceEth: number;
}) {
  try {
    const { address, privateKey, slug, offerPrice, creatorFees, enforceCreatorFee, trait, expiry, outbidOptions, maxBidPriceEth, contractAddress } = data
    let colletionOffer = BigInt(offerPrice)

    if (outbidOptions.outbid) {
      let highestBids = await fetchOpenseaOffers(address, "TRAIT", slug, contractAddress, JSON.parse(trait))
      highestBids = Number(highestBids)
      const outbidMargin = (outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
      const bidPrice = !highestBids ? Number(offerPrice) : highestBids + outbidMargin
      colletionOffer = BigInt(bidPrice)
    }

    if (maxBidPriceEth > 0 && Number(colletionOffer) / 1e18 > maxBidPriceEth) {
      console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `Offer price ${Number(colletionOffer) / 1e18} ETH for ${slug} ${trait} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '-----------------------------------------------------------------------------------------------------------------------------------------' + RESET);
      return
    }

    const bidCount = await getIncrementedBidCount(OPENSEA, slug)

    await bidOnOpensea(
      bidCount,
      address,
      privateKey,
      slug,
      colletionOffer,
      creatorFees,
      enforceCreatorFee,
      expiry,
      trait
    );
    const redisKey = `opensea:${slug}:${trait}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, offerPrice.toString());
  } catch (error) {
    console.error(RED + `Error processing OpenSea trait bid for task: ${data.slug}` + RESET, error);
  }
}

async function processOpenseaTokenBid(data: {
  address: string;
  privateKey: string;
  slug: string;
  offerPrice: string;
  creatorFees: IFee;
  enforceCreatorFee: boolean;
  asset: { contractAddress: string, tokenId: number },
  expiry: number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  }
  maxBidPriceEth: number;
}) {
  try {
    const { address, privateKey, slug, offerPrice, creatorFees, enforceCreatorFee, asset, expiry, outbidOptions, maxBidPriceEth } = data
    let colletionOffer = BigInt(offerPrice)

    if (outbidOptions.outbid) {
      let highestBids = await fetchOpenseaOffers(address, "TOKEN", slug, asset.contractAddress, asset.tokenId.toString())
      highestBids = Number(highestBids)
      const outbidMargin = (outbidOptions.openseaOutbidMargin || 0.0001) * 1e18
      const bidPrice = !highestBids ? Number(offerPrice) : highestBids + outbidMargin
      colletionOffer = BigInt(bidPrice.toString())
    }

    if (maxBidPriceEth > 0 && Number(colletionOffer) / 1e18 > maxBidPriceEth) {
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `Offer price ${Number(colletionOffer) / 1e18} ETH for ${slug} ${asset.tokenId} exceeds max bid price ${maxBidPriceEth} ETH FOR OPENSEA. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      return
    }


    const bidCount = await getIncrementedBidCount(OPENSEA, slug)
    await bidOnOpensea(
      bidCount,
      address,
      privateKey,
      slug,
      colletionOffer,
      creatorFees,
      enforceCreatorFee,
      expiry,
      undefined,
      asset
    )
    const redisKey = `opensea:${slug}:${asset.tokenId}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, colletionOffer.toString());

  } catch (error) {
    console.log(error);
  }
}

async function processBlurTraitBid(data: {
  address: string;
  privateKey: string;
  contractAddress: string;
  offerPrice: string;
  slug: string;
  trait: string;
  expiry: number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  };
  maxBidPriceEth: number
}) {
  const { address, privateKey, contractAddress, offerPrice, slug, trait, expiry, outbidOptions, maxBidPriceEth } = data;
  let collectionOffer = BigInt(offerPrice);

  try {
    if (outbidOptions.outbid) {
      const outbidMargin = outbidOptions.blurOutbidMargin || 0.01;
      const bids = await fetchBlurBid(slug, "TRAIT", JSON.parse(trait));
      const highestBids = bids?.priceLevels?.length ? bids.priceLevels.sort((a, b) => +b.price - +a.price)[0].price : 0;
      const bidPrice = Number(highestBids) + outbidMargin;
      collectionOffer = BigInt(Math.ceil(bidPrice * 1e18));
    }

    const offerPriceEth = Number(collectionOffer) / 1e18;
    if (maxBidPriceEth > 0 && offerPriceEth > maxBidPriceEth) {
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `Offer price ${offerPriceEth} ETH for ${slug} ${JSON.stringify(trait)} exceeds max bid price ${maxBidPriceEth} ETH. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
      return;
    }

    const bidCount = await getIncrementedBidCount(BLUR, slug)
    await bidOnBlur(bidCount, address, privateKey, contractAddress, collectionOffer, slug, expiry, trait);
    const redisKey = `blur:${slug}:${trait}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, collectionOffer.toString());
  } catch (error) {
    console.error(RED + `Error processing Blur trait bid for task: ${data.slug}` + RESET, error);
  }
}

async function processMagicedenScheduledBid(task: ITask) {
  try {
    if (!task.running || !task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("magiceden")) return

    const filteredTasks = Object.fromEntries(
      Object.entries(task?.selectedTraits || {}).map(([category, traits]) => [
        category,
        traits.filter(trait => trait.availableInMarketplaces.includes("magiceden"))
      ]).filter(([_, traits]) => traits.length > 0)
    );

    const WALLET_ADDRESS: string = task.wallet.address
    const WALLET_PRIVATE_KEY: string = task.wallet.privateKey
    const selectedTraits = transformNewTask(filteredTasks)

    const traitBid = selectedTraits && Object.keys(selectedTraits).length > 0
    const contractAddress = task.contract.contractAddress

    const expiry = getExpiry(task.bidDuration)
    const duration = expiry / 60 || 15; // minutes
    const currentTime = new Date().getTime();
    const expiration = Math.floor((currentTime + (duration * 60 * 1000)) / 1000);
    const floor_price = await fetchMagicEdenCollectionStats(task.contract.contractAddress)


    const autoIds = task.tokenIds
      .filter(id => id.toString().toLowerCase().startsWith('bot'))
      .map(id => {
        const matches = id.toString().match(/\d+/);
        return matches ? parseInt(matches[0]) : null;
      })
      .filter(id => id !== null);

    const bottlomListing = await fetchMagicEdenTokens(task.contract.contractAddress, autoIds[0])
    const taskTokenIds = task.tokenIds
    const tokenIds = [...bottlomListing, ...taskTokenIds]
    const tokenBid = task.bidType === "token" && tokenIds.length > 0

    if (floor_price === 0) return

    console.log(MAGENTA + `Current magiceden floor price for ${task.contract.slug}: ${floor_price} ETH`.toUpperCase() + RESET);

    const magicedenOutbidMargin = task.outbidOptions.magicedenOutbidMargin || 0.0001
    const { offerPriceEth, maxBidPriceEth } = calculateBidPrice(task, floor_price as number, "magiceden")

    const approved = await approveMarketplace(WETH_CONTRACT_ADDRESS, MAGICEDEN_MARKETPLACE, task, maxBidPriceEth);
    if (!approved) return

    let offerPrice = Math.ceil(offerPriceEth * 1e18)

    if (tokenBid) {
      const jobs = tokenIds
        .filter(token => !isNaN(Number(token))) // Filter out non-numeric tokens
        .map((token) => ({
          name: MAGICEDEN_TOKEN_BID,
          data: {
            address: WALLET_ADDRESS,
            contractAddress,
            quantity: 1,
            offerPrice,
            expiration,
            privateKey: WALLET_PRIVATE_KEY,
            slug: task.contract.slug,
            tokenId: token,
            outbidOptions: task.outbidOptions,
            maxBidPriceEth
          },
          opts: { priority: 5 }
        }))
      queue.addBulk(jobs)
    }
    else if (traitBid) {
      const traits = Object.entries(selectedTraits).flatMap(([key, values]) =>
        values.map(value => ({ attributeKey: key, attributeValue: value }))
      );
      const traitJobs = traits.map((trait) => ({
        name: MAGICEDEN_TRAIT_BID,
        data: {
          address: WALLET_ADDRESS,
          contractAddress,
          quantity: 1,
          offerPrice,
          expiration,
          privateKey: WALLET_PRIVATE_KEY,
          slug: task.contract.slug,
          trait
        },
        opts: { priority: 5 }
      }))
      const jobs = await queue.addBulk(traitJobs)
      console.log(`ADDED ${jobs.length} ${task.contract.slug} MAGICEDEN TRAIT BID JOBS TO QUEUE`);
    } else {
      if (task.outbidOptions.outbid) {
        const offer = await fetchMagicEdenOffer("COLLECTION", task.wallet.address, task.contract.contractAddress)
        if (offer && offer.amount) { // Check if offer and offer.amount are defined
          const highestOffer = +offer.amount.raw;
          offerPrice = Math.ceil(highestOffer + (magicedenOutbidMargin * 1e18));
        } else {
          console.error(RED + `No valid offer received for collection: ${task.contract.slug}` + RESET);
        }
      }
      if (maxBidPriceEth > 0 && Number(offerPrice) / 1e18 > maxBidPriceEth) {
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        console.log(RED + `Offer price ${Number(offerPrice) / 1e18} ETH for ${task.contract.slug} exceeds max bid price ${maxBidPriceEth} ETH FOR MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
        console.log(RED + '--------------------------------------------------------------------------------------------------' + RESET);
        return
      }

      const bidCount = await getIncrementedBidCount(MAGICEDEN, task.contract.slug)
      await bidOnMagiceden(bidCount, WALLET_ADDRESS, contractAddress, 1, offerPrice.toString(), expiration.toString(), WALLET_PRIVATE_KEY, task.contract.slug);
      const redisKey = `magiceden:${task.contract.slug}:collection`;
      const offerKey = `${bidCount}:${redisKey}`
      await redis.setex(offerKey, expiry, offerPrice.toString());
    }
  } catch (error) {
    console.error(RED + `Error processing MagicEden scheduled bid for task: ${task._id}` + RESET, error);
  }
}

async function processMagicedenTokenBid(data: {
  address: string;
  contractAddress: string;
  quantity: number;
  offerPrice: string;
  expiration: string;
  privateKey: string,
  slug: string;
  tokenId: string | number;
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  },
  maxBidPriceEth: number
}) {
  try {
    const
      {
        contractAddress,
        address,
        quantity,
        offerPrice,
        expiration,
        privateKey,
        slug,
        tokenId,
        outbidOptions,
        maxBidPriceEth
      } = data


    const magicedenOutbidMargin = outbidOptions?.magicedenOutbidMargin || 0.0001
    let collectionOffer = Number(offerPrice)

    if (outbidOptions?.outbid) {
      const offer = await fetchMagicEdenOffer("TOKEN", address, contractAddress, tokenId.toString())
      if (offer && offer.amount) { // Check if offer and offer.amount are defined
        const highestOffer = +offer.amount.raw
        collectionOffer = highestOffer + (magicedenOutbidMargin * 1e18)
      } else {
        console.error(RED + `No valid offer received for tokenId: ${tokenId}` + RESET);
      }
    }

    if (maxBidPriceEth > 0 && Number(collectionOffer / 1e18) > maxBidPriceEth) {
      console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
      console.log(RED + `magiceden offer ${collectionOffer / 1e18} WETH for ${slug} ${tokenId}  exceeds max bid price ${maxBidPriceEth} WETH ON MAGICEDEN. Skipping ...`.toUpperCase() + RESET);
      console.log(RED + '-----------------------------------------------------------------------------------------------------------' + RESET);
      return;
    }

    const bidCount = await getIncrementedBidCount(MAGICEDEN, slug)
    bidOnMagiceden(bidCount, address, contractAddress, quantity, collectionOffer.toString(), expiration.toString(), privateKey, slug, undefined, tokenId)
    const expiry = Math.ceil(+expiration - (Date.now() / 1000))
    const redisKey = `magiceden:${slug}:${tokenId}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, collectionOffer.toString());

  } catch (error) {
    console.error(RED + `Error processing MagicEden token bid for task: ${data.slug}` + RESET, error);
  }
}

async function processMagicedenTraitBid(data: {
  address: string;
  contractAddress: string;
  quantity: number;
  offerPrice: string;
  expiration: string;
  privateKey: string,
  slug: string;
  trait: {
    attributeKey: string;
    attributeValue: string;
  }
}) {
  try {
    const
      { contractAddress,
        address, quantity, offerPrice, expiration, privateKey, slug, trait } = data

    const bidCount = await getIncrementedBidCount(MAGICEDEN, slug)
    bidOnMagiceden(bidCount, address, contractAddress, quantity, offerPrice, expiration.toString(), privateKey, slug, trait)
    const expiry = Math.ceil(+expiration - (Date.now() / 1000))
    const redisKey = `magiceden:${slug}:${JSON.stringify(trait)}`;
    const offerKey = `${bidCount}:${redisKey}`
    await redis.setex(offerKey, expiry, offerPrice.toString());
  } catch (error) {
    console.error(RED + `Error processing MagicEden trait bid for task: ${data.slug}` + RESET, error);
  }
}

async function bulkCancelOpenseaBid(data: { orderHash: string, privateKey: string }) {
  try {
    const { orderHash, privateKey } = data
    await cancelOrder(orderHash, OPENSEA_PROTOCOL_ADDRESS, privateKey)
  } catch (error) {
    console.log(error);
  }
}

async function bulkCancelMagicedenBid(data: { orderIds: string[], privateKey: string }) {
  try {
    const { orderIds, privateKey } = data
    if (orderIds.length > 0) {
      await canelMagicEdenBid(orderIds, privateKey)
    }
  } catch (error) {
    console.log(error);
  }
}

async function blukCancelBlurBid(data: BlurCancelPayload) {
  try {
    await cancelBlurBid(data)
  } catch (error) {
    console.log(error);
  }
}

app.get("/", (req, res) => {
  res.json({ message: "Welcome to the NFTTools bidding bot server! Let's make magic happen! 🚀🚀🚀" });
});

function getExpiry(bidDuration: { value: number; unit: string }) {
  const expiry = bidDuration.unit === 'minutes'
    ? bidDuration.value * 60
    : bidDuration.unit === 'hours'
      ? bidDuration.value * 3600
      : bidDuration.unit === 'days'
        ? bidDuration.value * 86400
        : 900;

  return expiry
}

function calculateBidPrice(task: ITask, floorPrice: number, marketplaceName: "opensea" | "magiceden" | "blur"): { offerPriceEth: number; maxBidPriceEth: number } {
  const isGeneralBidPrice = task.bidPriceType === "GENERAL_BID_PRICE";

  const marketplaceBidPrice = marketplaceName.toLowerCase() === "blur" ? task.blurBidPrice
    : marketplaceName.toLowerCase() === "opensea" ? task.openseaBidPrice
      : marketplaceName.toLowerCase() === "magiceden" ? task.magicEdenBidPrice
        : task.bidPrice

  let bidPrice = isGeneralBidPrice ? task.bidPrice : marketplaceBidPrice;

  if (task.bidPriceType === "MARKETPLACE_BID_PRICE" && !marketplaceBidPrice) {
    if (!task.bidPrice) throw new Error("No bid price found");
    bidPrice = task.bidPrice;
  }

  let offerPriceEth: number;
  if (bidPrice.minType === "percentage") {
    offerPriceEth = Number((floorPrice * bidPrice.min / 100).toFixed(4));
    console.log(YELLOW + `Calculated offer price: ${offerPriceEth} ETH (${bidPrice.min}% of floor price)` + RESET);
  } else {
    offerPriceEth = bidPrice.min;
    console.log(YELLOW + `Using fixed offer price: ${offerPriceEth} ETH` + RESET);
  }

  let maxBidPriceEth: number;
  if (bidPrice.maxType === "percentage") {
    maxBidPriceEth = Number((floorPrice * (bidPrice.max || task.bidPrice.max) / 100).toFixed(4));
  } else {
    maxBidPriceEth = bidPrice.max || task.bidPrice.max;
  }

  return { offerPriceEth, maxBidPriceEth };
}

function transformBlurTraits(selectedTraits: Record<string, string[]>): { [key: string]: string }[] {
  const result: { [key: string]: string }[] = [];
  for (const [traitType, values] of Object.entries(selectedTraits)) {
    for (const value of values) {
      if (value.includes(',')) {
        const subValues = value.split(',');
        for (const subValue of subValues) {
          result.push({ [traitType]: subValue.trim() });
        }
      } else {
        result.push({ [traitType]: value.trim() });
      }
    }
  }
  return result;
}

async function getIncrementedBidCount(marketplace: string, slug: string): Promise<number> {
  const countKey = `${marketplace}:${slug}:bidCount`;
  return await redis.incr(countKey);
}

async function waitForUnlock(itemId: string, jobType: string) {
  if (waitingQueueCount >= RATE_LIMIT) {
    console.log(
      `Max waiting queue size reached. Ignoring ${jobType} for item ${itemId}.`
    );
    return;
  }

  waitingQueueCount++;
  try {
    while (itemId && itemLocks.get(itemId)) {
      console.log(`Waiting for item ${itemId} to be unlocked for ${jobType}.`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    waitingQueueCount--;
  }
}

function transformOpenseaTraits(selectedTraits: Record<string, string[]>): { type: string; value: string }[] {
  const result: { type: string; value: string }[] = [];
  for (const [traitType, values] of Object.entries(selectedTraits)) {
    for (const value of values) {
      if (value.includes(',')) {
        const subValues = value.split(',');
        for (const subValue of subValues) {
          result.push({ type: traitType, value: subValue.trim() });
        }
      } else {
        result.push({ type: traitType, value: value.trim() });
      }
    }
  }
  return result;
}

function subscribeToCollections(tasks: ITask[]) {
  try {
    tasks.forEach((task) => {
      // Check if ws is defined and ready
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error(RED + `WebSocket is not open for subscribing to collections: ${task.contract.slug}` + RESET);
        return; // Exit if WebSocket is not ready
      }

      const connectToOpensea = task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("opensea");
      const connectToBlur = task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("blur");
      const connectToMagiceden = task.selectedMarketplaces.map((marketplace) => marketplace.toLowerCase()).includes("magiceden");

      if (connectToOpensea && task.outbidOptions.counterbid && task.running) {
        const openseaSubscriptionMessage = {
          "slug": task.contract.slug,
          "event": "join_the_party",
          "topic": task.contract.slug,
          "contractAddress": task.contract.contractAddress,
          "clientId": task.user.toString(),
        };

        ws.send(JSON.stringify(openseaSubscriptionMessage));
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} OPENSEA`);
        console.log('----------------------------------------------------------------------');

        setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                event: "ping",
                "clientId": task.user.toString(),
              })
            );
          }
        }, 30000);
      }

      if (connectToMagiceden && task.outbidOptions.counterbid && task.running) {
        const magicedenSubscriptionMessage = {
          "topic": task.contract.slug,
          "slug": task.contract.slug,
          "contractAddress": task.contract.contractAddress,
          "event": "join_the_party",
          "clientId": task.user.toString(),
          "payload": {},
          "ref": 0
        }

        ws.send(JSON.stringify(magicedenSubscriptionMessage));
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} MAGICEDEN`);
        console.log('----------------------------------------------------------------------');

        setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                event: "ping",
                "clientId": task.user.toString(),
              })
            );
          }
        }, 30000);
      }

      if (connectToBlur && task.outbidOptions.counterbid && task.running) {
        const blurSubscriptionMessage = {
          "topic": task.contract.slug,
          "slug": task.contract.slug,
          "contractAddress": task.contract.contractAddress,
          "event": "join_the_party",
          "clientId": task.user.toString(),
          "payload": {},
          "ref": 0
        }

        ws.send(JSON.stringify(blurSubscriptionMessage));
        console.log('----------------------------------------------------------------------');
        console.log(`SUBSCRIBED TO COLLECTION: ${task.contract.slug} BLUR`);
        console.log('----------------------------------------------------------------------');
      }
    });
  } catch (error) {
    console.error(RED + 'Error subscribing to collections' + RESET, error);
  }
}

function checkOpenseaTrait(selectedTraits: any, trait_criteria: any) {
  if (selectedTraits.hasOwnProperty(trait_criteria.trait_type)) {
    return selectedTraits[trait_criteria.trait_type].includes(trait_criteria.trait_name);
  }
  return false;
}

function checkMagicEdenTrait(selectedTraits: Record<string, string[]>, trait: { attributeKey: string; attributeValue: string }) {
  if (selectedTraits.hasOwnProperty(trait.attributeKey)) {
    return selectedTraits[trait.attributeKey].includes(trait.attributeValue)
  }
  return false;
}

interface BlurCancelPayload {
  payload: {
    contractAddress: string;
    criteriaPrices: Array<{
      price: string;
      criteria?: {
        type: string;
        value: Record<string, string>;
      }
    }>;
  };
  privateKey: string;
}

function checkBlurTraits(incomingBids: any, traits: any) {
  const traitKeys = traits.flatMap((trait: any) => Object.entries(trait).map(([key, value]) => ({ key, value })));
  return incomingBids.filter((bid: any) => {
    return traitKeys.some((trait: any) => {
      return bid.criteriaValue[trait.key] === trait.value;
    });
  });
}


async function approveMarketplace(currency: string, marketplace: string, task: ITask, maxBidPriceEth: number): Promise<boolean> {
  try {

    const provider = new ethers.providers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);
    const signer = new Web3Wallet(task.wallet.privateKey, provider);
    const wethContract = new Contract(currency, WETH_MIN_ABI, signer);

    let allowance = await wethContract.allowance(task.wallet.address, marketplace)
    allowance = Number(allowance) / 1e18

    if (allowance > maxBidPriceEth) {
      return true
    }


    if (!task?.wallet.openseaApproval) {
      console.log(`Approving WETH ${marketplace} as a spender for wallet ${task.wallet.address} with amount: ${constants.MaxUint256.toString()}...`.toUpperCase());
      const tx = await wethContract.approve(marketplace, constants.MaxUint256);
      await tx.wait();
      if (marketplace.toLowerCase() === SEAPORT.toLowerCase()) {
        await Wallet.updateOne({ address: { $regex: new RegExp(task.wallet.address, 'i') } }, { openseaApproval: true });
        await Task.updateOne({ _id: task._id }, { $set: { 'wallet.openseaApproval': true } })
      }
      else if (marketplace.toLowerCase() === MAGICEDEN_MARKETPLACE.toLowerCase()) {
        await Wallet.updateOne({ address: { $regex: new RegExp(task.wallet.address, 'i') } }, { magicedenApproval: true });
        await Task.updateOne({ _id: task._id }, { $set: { 'wallet.magicedenApproval': true } });
      }
      return true
    } else {
      return true
    }
  } catch (error: any) {
    let name;
    if (marketplace.toLowerCase() === "0x0000000000000068f116a894984e2db1123eb395".toLowerCase()) {
      name = OPENSEA
    }
    else if (marketplace.toLowerCase() === "0x9A1D00bEd7CD04BCDA516d721A596eb22Aac6834".toLowerCase()) {
      name = MAGICEDEN
    }

    if (error.code === 'INSUFFICIENT_FUNDS') {
      console.log(RED + '--------------------------------------------------------------------------------------------------------------' + RESET);
      console.error(RED + `Error: Wallet ${task.wallet.address} could not approve ${name} as a spender. Please ensure your wallet has enough ETH to cover the gas fees and permissions are properly set.`.toUpperCase() + RESET);
      console.log(RED + '--------------------------------------------------------------------------------------------------------------' + RESET);
    } else {
      console.error(RED + `Error: Wallet ${task.wallet.address} could not approve the ${name} as a spender. Task has been stopped.`.toUpperCase() + RESET);
    }
    return false
  }
}



interface SelectedTraits {
  [key: string]: {
    name: string;
    availableInMarketplaces: string[];
  }[];
}

export interface ITask {
  _id: string;
  user: string;
  contract: {
    slug: string;
    contractAddress: string;
  };
  wallet: {
    address: string;
    privateKey: string;
    openseaApproval: boolean;
    blurApproval: boolean;
    magicedenApproval: boolean
  };
  selectedMarketplaces: string[];
  running: boolean;
  tags: { name: string; color: string }[];
  selectedTraits: SelectedTraits;
  traits: {
    categories: Record<string, string>;
    counts: Record<
      string,
      Record<string, { count: number; availableInMarketplaces: string[] }>
    >;
  };
  outbidOptions: {
    outbid: boolean;
    blurOutbidMargin: number | null;
    openseaOutbidMargin: number | null;
    magicedenOutbidMargin: number | null;
    counterbid: boolean;
  };
  bidPrice: {
    min: number;
    max: number;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  openseaBidPrice: {
    min: number;
    max: number;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  blurBidPrice: {
    min: number;
    max: number | null;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  magicEdenBidPrice: {
    min: number;
    max: number;
    minType: "percentage" | "eth";
    maxType: "percentage" | "eth";
  };

  stopOptions: {
    minFloorPrice: number | null;
    maxFloorPrice: number | null;
    minTraitPrice: number | null;
    maxTraitPrice: number | null;
    maxPurchase: number | null;
    pauseAllBids: boolean;
    stopAllBids: boolean;
    cancelAllBids: boolean;
    triggerStopOptions: boolean;
  };
  bidDuration: { value: number; unit: string };
  tokenIds: (number | string)[];
  bidType: string;
  loopInterval: { value: number; unit: string };
  bidPriceType: "GENERAL_BID_PRICE" | "MARKETPLACE_BID_PRICE";

}

interface BidLevel {
  contractAddress: string;
  updates: Update[];
}

interface Update {
  criteriaType: string;
  criteriaValue: Record<string, unknown>;
  price: string;
  executableSize: number;
  bidderCount: number;
  singleBidder: string | null;
}

interface BidStat {
  criteriaType: string;
  criteriaValue: { [key: string]: string };
  bestPrice: string;
  totalValue: string;
}

interface BidStats {
  contractAddress: string;
  stats: BidStat[];
}
interface CombinedBid extends BidStats, BidLevel { }


function transformNewTask(newTask: Record<string, Array<{ name: string }>>): Record<string, string[]> {
  const transformedTask: Record<string, string[]> = {};

  for (const key in newTask) {
    if (newTask.hasOwnProperty(key)) {
      transformedTask[key] = newTask[key].map(item => item.name);
    }
  }
  return transformedTask;
}