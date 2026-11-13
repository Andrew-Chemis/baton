import { Duration } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { ILogGroup } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface BatonMonitoringOptions {
  /** Where the alarms send ALARM and OK. Without one the alarms still exist and show in the console. */
  readonly alarmTopic?: ITopic;
  /** A CloudWatch dashboard of the board. It has a monthly charge of its own (beyond the free three per account). */
  readonly dashboard?: boolean;
  /** Lambda p99 duration, in milliseconds, that counts as slow. Default 3000; the function times out at 10 seconds. */
  readonly latencyP99Ms?: number;
}

export interface BatonMonitoringProps extends BatonMonitoringOptions {
  readonly prefix: string;
  readonly api: HttpApi;
  readonly fn: lambda.Function;
  readonly table: dynamodb.TableV2;
  readonly logGroup: ILogGroup;
  readonly metrics: boolean;
}

/** The DynamoDB operations the service makes; the throttle and error alarms watch these only. */
const OPERATIONS = [dynamodb.Operation.GET_ITEM, dynamodb.Operation.QUERY, dynamodb.Operation.TRANSACT_WRITE_ITEMS];

/**
 * Alarms for the failures a person has to act on, and optionally a dashboard. Each alarm is a standing charge (about $0.10 a
 * month per metric it watches), which is why the board creates them only when asked.
 */
export class BatonMonitoring extends Construct {
  public readonly alarms: cloudwatch.Alarm[] = [];
  public readonly dashboard?: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: BatonMonitoringProps) {
    super(scope, id);
    const five = Duration.minutes(5);
    const alarm = (
      name: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      evaluationPeriods = 1,
    ) => {
      const created = new cloudwatch.Alarm(this, name, {
        alarmName: `${props.prefix}-${name}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      if (props.alarmTopic) {
        created.addAlarmAction(new SnsAction(props.alarmTopic));
        created.addOkAction(new SnsAction(props.alarmTopic));
      }
      this.alarms.push(created);
      return created;
    };

    const serverErrors = props.api.metricServerError({ period: five, statistic: 'Sum' });
    const crashes = props.fn.metricErrors({ period: five, statistic: 'Sum' });
    const throttles = props.fn.metricThrottles({ period: five, statistic: 'Sum' });
    const p99 = props.fn.metricDuration({ period: five, statistic: 'p99' });
    const tableThrottles = props.table.metricThrottledRequestsForOperations({ operations: OPERATIONS, period: five });
    const tableErrors = props.table.metricSystemErrorsForOperations({ operations: OPERATIONS, period: five });

    alarm(
      'Api5xx',
      serverErrors,
      5,
      'Five or more 5xx answers in five minutes. Search the API log group for level ERROR; each line has the request id.',
    );
    alarm(
      'LambdaErrors',
      crashes,
      1,
      'The API function crashed or timed out. The handler answers its own errors, so this is an uncaught failure or a timeout.',
    );
    alarm(
      'LambdaThrottles',
      throttles,
      1,
      'The API function was throttled: the account concurrency limit was reached.',
    );
    alarm(
      'LatencyP99',
      p99,
      props.latencyP99Ms ?? 3000,
      'The slowest 1% of API calls took longer than the threshold for 15 minutes.',
      3,
    );
    alarm('TableThrottles', tableThrottles, 1, 'DynamoDB throttled a read or write on the board table.');
    alarm('TableSystemErrors', tableErrors, 1, 'DynamoDB answered a request on the board table with a 5xx.');

    if (props.dashboard) {
      const claims = (name: string) =>
        new cloudwatch.Metric({ namespace: 'Baton', metricName: name, period: five, statistic: 'Sum', label: name });
      const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
        dashboardName: `${props.prefix}-board`,
        defaultInterval: Duration.days(1),
      });
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Requests',
          left: [props.api.metricCount({ period: five, statistic: 'Sum', label: 'requests' })],
          right: [
            props.api.metricClientError({ period: five, statistic: 'Sum', label: '4xx' }),
            serverErrors.with({ label: '5xx' }),
          ],
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: 'API latency',
          left: [props.fn.metricDuration({ period: five, statistic: 'p50', label: 'p50' }), p99.with({ label: 'p99' })],
          width: 12,
        }),
      );
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Function',
          left: [crashes.with({ label: 'errors' }), throttles.with({ label: 'throttles' })],
          right: [props.fn.metricInvocations({ period: five, statistic: 'Sum', label: 'invocations' })],
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: 'Table',
          left: [
            props.table.metricConsumedReadCapacityUnits({ period: five, statistic: 'Sum', label: 'read units' }),
            props.table.metricConsumedWriteCapacityUnits({ period: five, statistic: 'Sum', label: 'write units' }),
          ],
          right: [
            props.table.metricConditionalCheckFailedRequests({
              period: five,
              statistic: 'Sum',
              label: 'conditions failed',
            }),
          ],
          width: 12,
        }),
      );
      if (props.metrics) {
        dashboard.addWidgets(
          new cloudwatch.GraphWidget({
            title: 'Claims',
            left: [claims('ClaimGranted'), claims('ClaimRefused'), claims('ClaimTakenOver')],
            width: 24,
          }),
        );
      }
      dashboard.addWidgets(
        new cloudwatch.LogQueryWidget({
          title: 'Refusals and errors by route and code',
          logGroupNames: [props.logGroup.logGroupName],
          queryLines: [
            'filter msg = "request" and status >= 400',
            'stats count(*) as n by route, code, status',
            'sort n desc',
            'limit 20',
          ],
          width: 24,
        }),
      );
      this.dashboard = dashboard;
    }
  }
}
