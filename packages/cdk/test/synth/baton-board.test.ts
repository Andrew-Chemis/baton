// Synthesizes the board the way a consumer does and checks what a deploy would create: the wiring of the two authorizers, the
// cost policy (nothing with a standing charge), and that the assets the construct needs are inside the package.
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { PublicHostedZone } from 'aws-cdk-lib/aws-route53';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { API_ASSET_PATH, WEB_ASSET_PATH } from '../../src/assets.ts';
import { BatonBoard, type BatonBoardProps } from '../../src/index.ts';
import { LATEST_SCHEMA } from '../../src/schema-version.ts';

function synth(props: Partial<BatonBoardProps> = {}, withEdge = true) {
  const app = new App();
  const edge = new Stack(app, 'Edge', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
  });
  const zone = new PublicHostedZone(edge, 'Zone', { zoneName: 'baton.example.test' });
  const certificate = new Certificate(edge, 'Cert', { domainName: 'baton.example.test' });
  const stack = new Stack(app, 'Board', {
    env: { account: '123456789012', region: 'us-west-2' },
    crossRegionReferences: true,
  });
  const board = new BatonBoard(stack, 'Board', {
    domainName: 'baton.example.test',
    ...(withEdge ? { certificate, hostedZone: zone } : {}),
    ...props,
  });
  const assembly = app.synth();
  return { app, assembly, stack, board, template: Template.fromStack(stack), edge: Template.fromStack(edge) };
}

describe('assets inside the package', () => {
  test('the Lambda bundle and the built web app exist where the construct looks', () => {
    expect(existsSync(join(API_ASSET_PATH, 'index.js'))).toBe(true);
    expect(existsSync(join(WEB_ASSET_PATH, 'index.html'))).toBe(true);
  });
});

describe('synthesis', () => {
  const { assembly, template } = synth();

  test('resolves with nothing missing from context, so no lookup needs credentials', () => {
    expect(assembly.manifest.missing ?? []).toEqual([]);
  });

  test('one Lambda asset serves the API and the token authorizer', () => {
    const ours = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (r: any) => r.Properties.Handler === 'index.handler' && r.Properties.Runtime === 'nodejs24.x',
    );
    expect(ours).toHaveLength(1);
    const authorizers = template.findResources('AWS::ApiGatewayV2::Authorizer');
    expect(Object.keys(authorizers)).toHaveLength(2);
    const fn = Object.values(authorizers).find((a) => a.Properties.AuthorizerType === 'REQUEST');
    const functionIds = Object.keys(template.findResources('AWS::Lambda::Function'));
    expect(JSON.stringify(fn?.Properties.AuthorizerUri)).toContain(
      functionIds.find((id) => id.startsWith('BoardApi')) as string,
    );
  });

  test('the Lambda role may use the table and its indexes with the calls the service makes, and nothing else on DynamoDB', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'));
    const dynamo = (id: string) =>
      policies
        .filter(([key]) => key.startsWith(id))
        .flatMap(([, p]: [string, any]) => p.Properties.PolicyDocument.Statement)
        .filter((s: any) => JSON.stringify(s.Action).includes('dynamodb'));
    const statements = dynamo('BoardApiServiceRole');
    expect(statements).toHaveLength(1);
    // Only the migration function scans, and it never touches an index.
    const migrate = dynamo('BoardMigrateServiceRole');
    expect(migrate).toHaveLength(1);
    expect(migrate[0].Action.toSorted((a: string, b: string) => a.localeCompare(b))).toEqual([
      'dynamodb:GetItem',
      'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ]);
    expect(JSON.stringify(migrate[0].Resource)).not.toContain('/index/');
    expect(statements[0].Action.toSorted((a: string, b: string) => a.localeCompare(b))).toEqual([
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ]);
  });

  test('two authorizers, one per route prefix, and no route without one', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 2);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      AuthorizerPayloadFormatVersion: '2.0',
      EnableSimpleResponses: true,
      AuthorizerResultTtlInSeconds: 300,
      IdentitySource: ['$request.header.Authorization'],
    });
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes.map((r) => String(r.Properties.RouteKey)).toSorted()).toEqual([
      'ANY /api/agent/{proxy+}',
      'ANY /api/human/{proxy+}',
    ]);
    for (const route of routes) {
      expect(['JWT', 'CUSTOM']).toContain(route.Properties.AuthorizationType);
      expect(route.Properties.AuthorizerId).toBeDefined();
    }
    const human = routes.find((r) => r.Properties.RouteKey.includes('/human/'));
    const agent = routes.find((r) => r.Properties.RouteKey.includes('/agent/'));
    expect(human?.Properties.AuthorizationType).toBe('JWT');
    expect(agent?.Properties.AuthorizationType).toBe('CUSTOM');
  });

  test('the table is a TableV2 on demand with the AWS-owned key, point-in-time recovery, TTL and three indexes, in one region', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      GlobalSecondaryIndexes: [
        Match.objectLike({ IndexName: 'GSI1' }),
        Match.objectLike({ IndexName: 'GSI2' }),
        Match.objectLike({ IndexName: 'GSI3' }),
      ],
      // The stack's own region and no other: a second replica would bill replicated writes.
      Replicas: [
        Match.objectLike({
          Region: 'us-west-2',
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          DeletionProtectionEnabled: true,
        }),
      ],
    });
    // `SSEEnabled: false` is how CloudFormation spells the AWS-owned key; a managed or customer key would say KMS.
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      SSESpecification: Match.exact({ SSEEnabled: false }),
    });
    template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain' });
  });

  test('cost policy: nothing with a standing charge', () => {
    const json = JSON.stringify(template.toJSON());
    for (const type of [
      'AWS::SecretsManager::Secret',
      'AWS::KMS::Key',
      'AWS::KMS::Alias',
      'AWS::ApplicationAutoScaling::ScalableTarget',
      'AWS::CloudWatch::Alarm',
      'AWS::CloudWatch::Dashboard',
    ]) {
      template.resourceCountIs(type, 0);
    }
    expect(json).not.toContain('ProvisionedThroughput');
    expect(json).not.toContain('ReadCapacityUnits');
    expect(json).not.toContain('WriteCapacityUnits');
    expect(json).not.toContain('ReservedConcurrentExecutions');
    expect(json).not.toContain('ProvisionedConcurrencyConfig');
    expect(json).not.toContain('aws:kms');
    for (const type of [
      'AWS::CloudFront::CachePolicy',
      'AWS::CloudFront::OriginRequestPolicy',
      'AWS::CloudFront::ResponseHeadersPolicy',
      'AWS::WAFv2::WebACL',
    ]) {
      template.resourceCountIs(type, 0);
    }
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('the user pool admits no self sign-up and the client is a public code-flow client with the board callback', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      DeletionProtection: 'ACTIVE',
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: ['https://baton.example.test/auth/callback'],
      LogoutURLs: ['https://baton.example.test/'],
    });
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  test('the edge serves the app and the API from one name, with managed policies and no WAF of its own', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['baton.example.test'],
        PriceClass: 'PriceClass_All',
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/api/*',
            ViewerProtocolPolicy: 'https-only',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
          }),
        ],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          FunctionAssociations: [
            Match.objectLike({ EventType: 'viewer-request' }),
            Match.objectLike({ EventType: 'viewer-response' }),
          ],
        }),
      }),
    });
    // The API origin is the host of the API's endpoint, worked out in the template, never the endpoint's full URL.
    const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const origins = distribution?.Properties.DistributionConfig.Origins as { DomainName: unknown }[];
    const api = origins.find(
      (o) => typeof o.DomainName === 'object' && JSON.stringify(o.DomainName).includes('Fn::Split'),
    );
    expect(api, 'an origin whose domain is parsed from the API endpoint').toBeDefined();
    expect(JSON.stringify(api?.DomainName)).not.toContain('https://');
    expect(Object.keys(api?.DomainName as object)).toEqual(['Fn::Select']);
    expect(JSON.stringify(api?.DomainName)).toContain('ApiEndpoint');
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::Function', 2);
    // The headers function also marks the content-named files under /assets/ immutable, and only those, and only when served.
    const code = Object.values(template.findResources('AWS::CloudFront::Function'))
      .map((f) => f.Properties.FunctionCode as string)
      .find((c) => c.includes('strict-transport-security'));
    expect(code, 'the security headers function').toBeDefined();
    const handler = runInNewContext(`${code}; handler`) as (event: unknown) => { headers: Record<string, any> };
    const respond = (uri: string, statusCode: number) =>
      handler({ request: { uri }, response: { statusCode, headers: { 'cache-control': { value: 'max-age=0' } } } })
        .headers;
    expect(respond('/assets/index-DkkBH9eh.js', 200)['cache-control']).toEqual({
      value: 'public, max-age=31536000, immutable',
    });
    expect(respond('/assets/index-DkkBH9eh.js', 200)['strict-transport-security']).toBeDefined();
    expect(respond('/index.html', 200)['cache-control']).toEqual({ value: 'max-age=0' });
    expect(respond('/config.json', 200)['cache-control']).toEqual({ value: 'max-age=0' });
    expect(respond('/assets/missing.js', 404)['cache-control']).toEqual({ value: 'max-age=0' });
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
    template.resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
  });
});

describe('options', () => {
  test('without a certificate and a zone there is no edge, and giving one without the other is refused', () => {
    const { template, board } = synth({}, false);
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    expect(board.edge).toBeUndefined();
    const app = new App();
    const stack = new Stack(app, 'S');
    expect(
      () =>
        new BatonBoard(stack, 'B', {
          domainName: 'x.example.test',
          hostedZone: PublicHostedZone.fromHostedZoneId(stack, 'Z', 'Z123'),
        }),
    ).toThrow(/go together/);
  });

  test('a flat-rate plan subscribes the distribution, its web ACL and, if given, the zone', () => {
    const webAclArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/test/00000000-0000-0000-0000-000000000000';
    const { template } = synth({ flatRatePlan: { tier: 'FREE', webAclArn, hostedZoneId: 'Z0TESTZONE' } });
    template.hasResourceProperties('AWS::PricingPlanManager::Subscription', {
      PlanFamily: 'CloudFront',
      PlanTier: 'FREE',
      UsageLevel: 'DEFAULT',
    });
    const sub = Object.values(template.findResources('AWS::PricingPlanManager::Subscription'))[0];
    expect(sub?.Properties.ResourceArns).toHaveLength(3);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ WebACLId: webAclArn }),
    });
  });

  test('protectData: false lets the stack delete the data, and leaves no retained resource', () => {
    const { template } = synth({ protectData: false });
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: [Match.objectLike({ DeletionProtectionEnabled: false })],
    });
    const retained = Object.entries(template.toJSON().Resources as Record<string, any>).filter(
      ([, r]) => r.DeletionPolicy === 'Retain',
    );
    expect(retained.map(([id]) => id)).toEqual([]);
  });

  test('lease and heartbeat reach the Lambda, and a heartbeat slower than the lease is refused', () => {
    const { template } = synth({ leaseMinutes: 5, heartbeatSeconds: 30 });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Environment: { Variables: Match.objectLike({ BATON_LEASE_MINUTES: '5', BATON_HEARTBEAT_SECONDS: '30' }) },
    });
    const stack = new Stack(new App(), 'S');
    expect(
      () => new BatonBoard(stack, 'B', { domainName: 'x.example.test', leaseMinutes: 1, heartbeatSeconds: 60 }),
    ).toThrow(/shorter than the lease/);
  });

  test('observability: JSON function logs, an access log with no headers or query, and no metrics unless asked', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      LoggingConfig: Match.objectLike({ LogFormat: 'JSON', ApplicationLogLevel: 'INFO' }),
      Environment: { Variables: Match.not(Match.objectLike({ BATON_METRICS: Match.anyValue() })) },
    });
    const stage = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'))[0] as any;
    const format = JSON.parse(stage.Properties.AccessLogSettings.Format as string);
    expect(Object.keys(format)).toEqual(
      expect.arrayContaining(['requestId', 'routeKey', 'status', 'authorizerError', 'latencyMs']),
    );
    expect(JSON.stringify(format)).not.toMatch(/header|querystring|body/i);
    template.resourceCountIs('AWS::Logs::LogGroup', 3);
    template.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  test('monitoring: six alarms that notify the topic, a dashboard when asked, and metrics on the Lambda', () => {
    const app = new App();
    const stack = new Stack(app, 'S', { env: { account: '123456789012', region: 'us-west-2' } });
    const topic = new Topic(stack, 'Alerts');
    new BatonBoard(stack, 'B', {
      domainName: 'x.example.test',
      metrics: true,
      monitoring: { alarmTopic: topic, dashboard: true },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    template.allResourcesProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^Alerts') }],
      OKActions: [{ Ref: Match.stringLikeRegexp('^Alerts') }],
      TreatMissingData: 'notBreaching',
    });
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Environment: { Variables: Match.objectLike({ BATON_METRICS: '1' }) },
    });
    const body = JSON.stringify(Object.values(template.findResources('AWS::CloudWatch::Dashboard'))[0]);
    expect(body).toContain('ClaimTakenOver');
  });

  test('an admin group exists in the pool and its name reaches the Lambda', () => {
    const { template } = synth({ adminGroupName: 'board-admins' });
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'board-admins' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Environment: { Variables: Match.objectLike({ BATON_ADMIN_GROUP: 'board-admins' }) },
    });
  });

  test('every deploy that raises the schema version runs the migrations from the same bundle', () => {
    const { template } = synth();
    template.hasResourceProperties('Custom::BatonSchema', { SchemaVersion: String(LATEST_SCHEMA) });
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const api = fns.find((f) => f.Properties.Handler === 'index.handler');
    const migrate = fns.find((f) => f.Properties.Handler === 'index.migrate');
    expect(migrate.Properties.Code.S3Key).toEqual(api.Properties.Code.S3Key);
    expect(migrate.Properties.Timeout).toBe(14 * 60);
  });
});
