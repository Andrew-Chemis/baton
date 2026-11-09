import { Duration, Stack } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { CfnSubscription } from 'aws-cdk-lib/aws-pricingplanmanager';
import { AaaaRecord, ARecord, type IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { WEB_ASSET_PATH } from './assets.js';
import { CONTENT_SECURITY_POLICY } from './csp.js';
import { API_ROOT } from './schema.js';

export { CONTENT_SECURITY_POLICY };

export type FlatRatePlanTier = 'FREE' | 'PRO' | 'BUSINESS' | 'PREMIUM';

/**
 * Puts the distribution on a CloudFront flat-rate plan. The plan requires a CLOUDFRONT-scope web ACL, which exists only in
 * us-east-1; create it there, and pass its ARN. A plan accepts only AWS-managed cache, origin request and response header
 * policies at the FREE and PRO tiers, which is all this construct uses.
 */
export interface FlatRatePlan {
  readonly tier: FlatRatePlanTier;
  readonly webAclArn: string;
  /** Fold a Route 53 zone into the plan. A zone belongs to at most one plan. */
  readonly hostedZoneId?: string;
}

/** What the single-page app reads from /config.json at start. */
export interface BatonWebConfig {
  /** Same-origin path of the API. */
  readonly apiUrl: string;
  readonly cognito: {
    /** Base URL of the hosted UI, https://<prefix>.auth.<region>.amazoncognito.com */
    readonly domain: string;
    readonly clientId: string;
  };
}

export interface BatonDistributionProps {
  /** The name the board is served on, e.g. baton.example.com. */
  readonly domainName: string;
  /** Viewer certificate for `domainName`, in us-east-1. */
  readonly certificate: ICertificate;
  /** The zone `domainName` is in. */
  readonly hostedZone: IHostedZone;
  /** Where the web app is kept; the construct deploys the built app into it. */
  readonly bucket: s3.IBucket;
  /** Host name of the HTTP API, without scheme or path. */
  readonly apiDomainName: string;
  readonly webConfig: BatonWebConfig;
  readonly flatRatePlan?: FlatRatePlan;
  /** Prefix for the names of the CloudFront functions. Default `baton`. */
  readonly resourcePrefix?: string;
  /** Path of the built web app. Default: the one inside this package. */
  readonly webAssetPath?: string;
}

/**
 * The CloudFront piece: the single-page app from a private S3 bucket (Origin Access Control) on `/*`, the API on `/api/*`,
 * the alias records, and the deployment of the built app. Everything is an AWS-managed policy plus two CloudFront Functions,
 * so the distribution stays eligible for the FREE and PRO flat-rate tiers.
 *
 * Place it in the same stack as the bucket: the bucket policy that admits the distribution lives with the bucket, and the
 * distribution needs the bucket, so two stacks would depend on each other.
 */
export class BatonDistribution extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly url: string;

  constructor(scope: Construct, id: string, props: BatonDistributionProps) {
    super(scope, id);
    const prefix = props.resourcePrefix ?? 'baton';

    // Headers come from a function, not a response headers policy: custom policies are refused by the FREE and PRO plans.
    const hstsSeconds = Duration.days(365).toSeconds();
    const securityHeaders = new cloudfront.Function(this, 'SecurityHeaders', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var headers = event.response.headers;',
          `  headers['strict-transport-security'] = { value: 'max-age=${hstsSeconds}; includeSubDomains' };`,
          "  headers['x-content-type-options'] = { value: 'nosniff' };",
          "  headers['x-frame-options'] = { value: 'DENY' };",
          "  headers['referrer-policy'] = { value: 'same-origin' };",
          `  headers['content-security-policy'] = { value: ${JSON.stringify(CONTENT_SECURITY_POLICY)} };`,
          '  return event.response;',
          '}',
        ].join('\n'),
      ),
    });

    // Extension-less paths are client-side routes. Not `errorResponses`: those apply to every origin and would turn the
    // API's JSON 404s into a 200 page.
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          "  if (request.uri.endsWith('/')) { request.uri += 'index.html'; return request; }",
          "  if (request.uri.indexOf('.') === -1) { request.uri = '/index.html'; }",
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${prefix} board`,
      domainNames: [props.domainName],
      certificate: props.certificate,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // The flat-rate plan API rejected a narrower price class.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      ...(props.flatRatePlan ? { webAclId: props.flatRatePlan.webAclArn } : {}),
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(props.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          { function: securityHeaders, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
      additionalBehaviors: {
        [`${API_ROOT}/*`]: {
          origin: new HttpOrigin(props.apiDomainName, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forwards Authorization and the query string; drops Host so the API sees its own name.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
    });

    if (props.flatRatePlan) {
      const stack = Stack.of(this);
      const resourceArns = [
        stack.formatArn({
          service: 'cloudfront',
          region: '',
          resource: 'distribution',
          resourceName: this.distribution.distributionId,
        }),
        props.flatRatePlan.webAclArn,
        ...(props.flatRatePlan.hostedZoneId
          ? [
              stack.formatArn({
                service: 'route53',
                region: '',
                account: '',
                resource: 'hostedzone',
                resourceName: props.flatRatePlan.hostedZoneId,
              }),
            ]
          : []),
      ];
      new CfnSubscription(this, 'FlatRatePlan', {
        planFamily: 'CloudFront',
        planTier: props.flatRatePlan.tier,
        usageLevel: 'DEFAULT',
        resourceArns,
      });
    }

    const alias = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    new ARecord(this, 'AliasRecord', { zone: props.hostedZone, recordName: props.domainName, target: alias });
    new AaaaRecord(this, 'AliasRecordIpv6', { zone: props.hostedZone, recordName: props.domainName, target: alias });

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(props.webAssetPath ?? WEB_ASSET_PATH),
        s3deploy.Source.jsonData('config.json', props.webConfig),
      ],
      destinationBucket: props.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      // Always revalidated, so a deploy is visible on the next load; CloudFront's invalidation covers the edge.
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, must-revalidate')],
      prune: true,
      memoryLimit: 512,
    });

    this.url = `https://${props.domainName}`;
  }
}
