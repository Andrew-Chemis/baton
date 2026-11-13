import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnStage, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpJwtAuthorizer,
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { API_ASSET_PATH } from './assets.js';
import { BatonDistribution, type FlatRatePlan } from './baton-distribution.js';
import { BatonMonitoring, type BatonMonitoringOptions } from './baton-monitoring.js';
import {
  AGENT_PREFIX,
  GSI1,
  GSI2,
  GSI3,
  HEARTBEAT_SECONDS_DEFAULT,
  HUMAN_PREFIX,
  LEASE_MINUTES_DEFAULT,
  METRICS_ENV,
  TABLE_KEYS,
  TIMING_ENV,
  TTL_ATTRIBUTE,
  timingProblem,
} from './schema.js';

export interface BatonBoardProps {
  /** The name the board is served on, e.g. baton.example.com. It is also the Cognito callback origin. */
  readonly domainName: string;
  /** Viewer certificate for `domainName`, in us-east-1. Give it with `hostedZone` to get the CloudFront edge. */
  readonly certificate?: ICertificate;
  /** The zone `domainName` is in. */
  readonly hostedZone?: IHostedZone;
  /** How long a claim lasts without a heartbeat. Default 10. */
  readonly leaseMinutes?: number;
  /** How often agents are asked to send a heartbeat. Default 60. Must be shorter than the lease. */
  readonly heartbeatSeconds?: number;
  /** Keep the table, the user pool and the bucket when the stack is deleted, and turn on deletion protection. Default true. */
  readonly protectData?: boolean;
  /** Put the distribution on a CloudFront flat-rate plan. */
  readonly flatRatePlan?: FlatRatePlan;
  /** Names the Lambda, log group and CloudFront functions. Default `baton`. */
  readonly resourcePrefix?: string;
  /** Hosted UI domain prefix; must be unique in the region. Default derives one from the stack id. */
  readonly cognitoDomainPrefix?: string;
  /** Extra OAuth callback URLs, for local development. */
  readonly extraCallbackUrls?: string[];
  /**
   * Emit the claim metrics (granted, refused, taken over) and a server-error count to CloudWatch, namespace `Baton`. Four
   * custom metrics with no dimensions: a fixed, small monthly charge. Default false; the request log is written either way.
   */
  readonly metrics?: boolean;
  /** Alarms, and optionally a dashboard. Default none: each alarm is a standing charge. */
  readonly monitoring?: BatonMonitoringOptions;
  /** How long the function and access logs are kept. Default one month. */
  readonly logRetention?: RetentionDays;
}

/**
 * The whole board: table, user pool, HTTP API with its two authorizers, the one Lambda, the web app's bucket and, given a
 * certificate and a hosted zone, the CloudFront edge. Pay per request throughout: no provisioned capacity, no customer-managed
 * key, no secret in Secrets Manager.
 */
export class BatonBoard extends Construct {
  public readonly table: dynamodb.TableV2;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly api: HttpApi;
  public readonly apiFunction: lambda.Function;
  public readonly bucket: s3.Bucket;
  /** Set when a certificate and a hosted zone were given. */
  public readonly edge?: BatonDistribution;
  /** Set when `monitoring` was given. */
  public readonly monitoring?: BatonMonitoring;
  /** The function's log: one JSON line per request (see the README's Operations section). */
  public readonly logGroup: LogGroup;
  /** API Gateway's access log, which also records the requests an authorizer refused before the function ran. */
  public readonly accessLogGroup: LogGroup;
  /** https://<domainName> */
  public readonly url: string;

  constructor(scope: Construct, id: string, props: BatonBoardProps) {
    super(scope, id);
    const prefix = props.resourcePrefix ?? 'baton';
    const protect = props.protectData ?? true;
    const leaseMinutes = props.leaseMinutes ?? LEASE_MINUTES_DEFAULT;
    const heartbeatSeconds = props.heartbeatSeconds ?? HEARTBEAT_SECONDS_DEFAULT;
    const timing = timingProblem(leaseMinutes, heartbeatSeconds);
    if (timing) throw new Error(`BatonBoard: ${timing}`);
    if (Boolean(props.certificate) !== Boolean(props.hostedZone)) {
      throw new Error(
        'BatonBoard: certificate and hostedZone go together; give both for the CloudFront edge, or neither',
      );
    }
    const removal = protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: TABLE_KEYS.pk, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TABLE_KEYS.sk, type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // The AWS-owned key: no customer-managed key to pay for.
      encryption: dynamodb.TableEncryptionV2.dynamoOwnedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: TTL_ATTRIBUTE,
      deletionProtection: protect,
      removalPolicy: removal,
      globalSecondaryIndexes: [GSI1, GSI2, GSI3].map((gsi) => ({
        indexName: gsi.name,
        partitionKey: { name: gsi.pk, type: dynamodb.AttributeType.STRING },
        sortKey: { name: gsi.sk, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      })),
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      // Authenticator-app codes only: SMS would bill per message.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      deletionProtection: protect,
      removalPolicy: removal,
    });
    const domainPrefix =
      props.cognitoDomainPrefix ??
      Fn.join('-', [prefix, Fn.select(0, Fn.split('-', Fn.select(2, Fn.split('/', Aws.STACK_ID))))]);
    const hostedUi = this.userPool.addDomain('HostedUi', { cognitoDomain: { domainPrefix } });
    const origin = `https://${props.domainName}`;
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${prefix}-web`,
      generateSecret: false,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${origin}/auth/callback`, ...(props.extraCallbackUrls ?? [])],
        logoutUrls: [`${origin}/`],
      },
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    const retention = props.logRetention ?? RetentionDays.ONE_MONTH;
    const logGroup = new LogGroup(this, 'ApiLogs', { retention, removalPolicy: RemovalPolicy.DESTROY });
    this.logGroup = logGroup;
    this.apiFunction = new lambda.Function(this, 'Api', {
      description: 'Baton board API and agent-token authorizer',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(API_ASSET_PATH),
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup,
      // JSON, so Logs Insights can query the request lines and the runtime's own lines by field.
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
      environment: {
        BATON_TABLE: this.table.tableName,
        ...(props.metrics ? { [METRICS_ENV]: '1' } : {}),
        [TIMING_ENV.leaseMinutes]: String(leaseMinutes),
        [TIMING_ENV.heartbeatSeconds]: String(heartbeatSeconds),
      },
    });
    // The actions DynamoDB checks for the calls and transactions the service makes, on the table and its indexes, and no more.
    this.apiFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [this.table.tableArn, `${this.table.tableArn}/index/*`],
      }),
    );

    this.api = new HttpApi(this, 'HttpApi', {
      apiName: `${prefix}-api`,
      description: 'Baton board API',
      createDefaultStage: true,
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', this.apiFunction);
    const humans = new HttpJwtAuthorizer(
      'HumanAuthorizer',
      `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}`,
      { jwtAudience: [this.userPoolClient.userPoolClientId], identitySource: ['$request.header.Authorization'] },
    );
    // The same function answers as authorizer. It authorizes every request that carries an Authorization header and records
    // the verdict, because an HTTP API cannot customize a denial; the handler turns a bad verdict into a 401 that says what to
    // do. The result is cached for five minutes, the longest a revoked token keeps working.
    const agents = new HttpLambdaAuthorizer('AgentAuthorizer', this.apiFunction, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: Duration.minutes(5),
    });
    this.api.addRoutes({
      path: `${HUMAN_PREFIX}/{proxy+}`,
      methods: [HttpMethod.ANY],
      integration,
      authorizer: humans,
    });
    this.api.addRoutes({
      path: `${AGENT_PREFIX}/{proxy+}`,
      methods: [HttpMethod.ANY],
      integration,
      authorizer: agents,
    });
    // A ceiling on request rate: a loop in an agent costs requests, and requests are what this stack bills for.
    const stage = this.api.defaultStage?.node.defaultChild as CfnStage | undefined;
    this.accessLogGroup = new LogGroup(this, 'AccessLogs', { retention, removalPolicy: RemovalPolicy.DESTROY });
    if (stage) {
      stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };
      // No headers, no query string, no body: the route key and the outcome. `requestId` matches the function's line.
      stage.accessLogSettings = {
        destinationArn: this.accessLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          time: '$context.requestTimeEpoch',
          ip: '$context.identity.sourceIp',
          method: '$context.httpMethod',
          routeKey: '$context.routeKey',
          status: '$context.status',
          latencyMs: '$context.responseLatency',
          integrationStatus: '$context.integrationStatus',
          authorizerError: '$context.authorizer.error',
          integrationError: '$context.integrationErrorMessage',
        }),
      };
    }

    this.bucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: removal,
      autoDeleteObjects: !protect,
    });

    this.url = origin;
    if (props.certificate && props.hostedZone) {
      this.edge = new BatonDistribution(this, 'Edge', {
        domainName: props.domainName,
        certificate: props.certificate,
        hostedZone: props.hostedZone,
        bucket: this.bucket,
        // apiEndpoint is a deploy-time token, so a string replace would strip nothing; parse the host out in the template.
        apiDomainName: Fn.parseDomainName(this.api.apiEndpoint),
        webConfig: {
          apiUrl: '/api',
          cognito: { domain: hostedUi.baseUrl(), clientId: this.userPoolClient.userPoolClientId },
        },
        flatRatePlan: props.flatRatePlan,
        resourcePrefix: prefix,
      });
    }

    if (props.monitoring) {
      this.monitoring = new BatonMonitoring(this, 'Monitoring', {
        ...props.monitoring,
        prefix,
        api: this.api,
        fn: this.apiFunction,
        table: this.table,
        logGroup,
        metrics: props.metrics ?? false,
      });
    }

    new CfnOutput(this, 'BoardUrl', { value: this.url, description: 'Where the board is served' });
    new CfnOutput(this, 'TableName', { value: this.table.tableName, description: 'DynamoDB table' });
    new CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint, description: 'HTTP API endpoint behind /api/*' });
    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito user pool: create the sign-in user here',
    });
  }
}
