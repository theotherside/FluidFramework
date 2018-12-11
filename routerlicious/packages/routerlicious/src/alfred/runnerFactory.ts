import { KafkaOrdererFactory } from "@prague/kafka-orderer";
import {
    LocalNodeFactory,
    LocalOrderManager,
    NodeManager,
    ReservationManager,
} from "@prague/memory-orderer";
import * as services from "@prague/services";
import * as core from "@prague/services-core";
import * as utils from "@prague/services-utils";
import * as bytes from "bytes";
import { Provider } from "nconf";
import * as os from "os";
import { AlfredRunner } from "./runner";

export class OrdererManager implements core.IOrdererManager {
    constructor(private localOrderManager: LocalOrderManager, private kafkaFactory?: KafkaOrdererFactory) {
    }

    public async getOrderer(tenantId: string, documentId: string): Promise<core.IOrderer> {
        if (tenantId === "local" || !this.kafkaFactory) {
            return this.localOrderManager.get(tenantId, documentId);
        } else {
            return this.kafkaFactory.create(tenantId, documentId);
        }
    }
}

export class AlfredResources implements utils.IResources {
    public webServerFactory: core.IWebServerFactory;

    constructor(
        public config: Provider,
        public producer: core.IProducer,
        public redisConfig: any,
        public webSocketLibrary: string,
        public orderManager: core.IOrdererManager,
        public tenantManager: core.ITenantManager,
        public storage: core.IDocumentStorage,
        public appTenants: core.IAlfredTenant[],
        public mongoManager: utils.MongoManager,
        public port: any,
        public documentsCollectionName: string,
        public metricClientConfig: any,
        public contentCollection: core.ICollection<any>) {

        this.webServerFactory = new services.SocketIoWebServerFactory(this.redisConfig);
    }

    public async dispose(): Promise<void> {
        const producerClosedP = this.producer.close();
        const mongoClosedP = this.mongoManager.close();
        await Promise.all([producerClosedP, mongoClosedP]);
    }
}

export class AlfredResourcesFactory implements utils.IResourcesFactory<AlfredResources> {
    public async create(config: Provider): Promise<AlfredResources> {
        // Producer used to publish messages
        const kafkaEndpoint = config.get("kafka:lib:endpoint");
        const kafkaLibrary = config.get("kafka:lib:name");
        const kafkaClientId = config.get("alfred:kafkaClientId");
        const topic = config.get("alfred:topic");
        const metricClientConfig = config.get("metric");
        const maxKafkaMessageSize = bytes.parse(config.get("kafka:maxMessageSize"));
        const producer = services.createProducer(
            kafkaLibrary,
            kafkaEndpoint,
            kafkaClientId,
            topic,
            maxKafkaMessageSize);
        const redisConfig = config.get("redis");
        const webSocketLibrary = config.get("alfred:webSocketLib");
        const authEndpoint = config.get("auth:endpoint");

        // Database connection
        const mongoUrl = config.get("mongo:endpoint") as string;
        const mongoFactory = new services.MongoDbFactory(mongoUrl);
        const mongoManager = new utils.MongoManager(mongoFactory);
        const documentsCollectionName = config.get("mongo:collectionNames:documents");

        // create the index on the documents collection
        const db = await mongoManager.getDatabase();
        const documentsCollection = db.collection<core.IDocument>(documentsCollectionName);
        await documentsCollection.createIndex(
            {
                documentId: 1,
                tenantId: 1,
            },
            true);
        const deltasCollectionName = config.get("mongo:collectionNames:deltas");

        // tmz agent uploader does not run locally.
        // TODO: Make agent uploader run locally.
        const tmzConfig = config.get("tmz");
        const taskMessageSender = services.createMessageSender(config.get("rabbitmq"), tmzConfig);
        await taskMessageSender.initialize();

        const nodeCollectionName = config.get("mongo:collectionNames:nodes");
        const nodeManager = new NodeManager(mongoManager, nodeCollectionName);
        // this.nodeTracker.on("invalidate", (id) => this.emit("invalidate", id));
        const reservationManager = new ReservationManager(
            nodeManager,
            mongoManager,
            config.get("mongo:collectionNames:reservations"));

        const tenantManager = new services.TenantManager(authEndpoint, config.get("worker:blobStorageUrl"));

        const databaseManager = new utils.MongoDatabaseManager(
            mongoManager,
            nodeCollectionName,
            documentsCollectionName,
            deltasCollectionName);

        const storage = new services.DocumentStorage(databaseManager, tenantManager, producer);

        const maxSendMessageSize = bytes.parse(config.get("alfred:maxMessageSize"));

        const contentCollection = db.collection("content");
        await contentCollection.createIndex(
            {
                documentId: 1,
                sequenceNumber: 1,
                tenantId: 1,
            },
            false);

        const address = `${await utils.getHostIp()}:4000`;
        const nodeFactory = new LocalNodeFactory(
            os.hostname(),
            address,
            storage,
            databaseManager,
            60000,
            taskMessageSender,
            tenantManager,
            tmzConfig.permissions,
            maxSendMessageSize);
        const localOrderManager = new LocalOrderManager(nodeFactory, reservationManager);
        const kafkaOrdererFactory = new KafkaOrdererFactory(
            producer,
            storage,
            maxSendMessageSize);
        const orderManager = new OrdererManager(localOrderManager, kafkaOrdererFactory);

        // Tenants attached to the apps this service exposes
        const appTenants = config.get("alfred:tenants") as Array<{ id: string, key: string }>;

        // This wanst to create stuff
        const port = utils.normalizePort(process.env.PORT || "3000");

        return new AlfredResources(
            config,
            producer,
            redisConfig,
            webSocketLibrary,
            orderManager,
            tenantManager,
            storage,
            appTenants,
            mongoManager,
            port,
            documentsCollectionName,
            metricClientConfig,
            contentCollection);
    }
}

export class AlfredRunnerFactory implements utils.IRunnerFactory<AlfredResources> {
    public async create(resources: AlfredResources): Promise<utils.IRunner> {
        return new AlfredRunner(
            resources.webServerFactory,
            resources.config,
            resources.port,
            resources.orderManager,
            resources.tenantManager,
            resources.storage,
            resources.appTenants,
            resources.mongoManager,
            resources.producer,
            resources.metricClientConfig,
            resources.contentCollection);
    }
}
