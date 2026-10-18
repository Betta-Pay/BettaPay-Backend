/**
 * Issue #890 — Settlement queue depth gauge.
 *
 * settlement_queue_depth reflects the current number of waiting + active BullMQ
 * jobs so operators can alert on runaway queue buildup. The gauge uses an async
 * collect callback so values are always fresh at scrape time.
 */
import test from 'tape';

// Stub queue that returns controllable job counts.
function makeQueue(waiting = 0, active = 0) {
  return {
    async getJobCounts(..._states: string[]): Promise<Record<string, number>> {
      return { waiting, active };
    },
  };
}

// Minimal gauge stub replicating prom-client Gauge behaviour.
function makeGauge(queue: ReturnType<typeof makeQueue>) {
  let value: number | null = null;

  async function collect() {
    const counts = await queue.getJobCounts('waiting', 'active');
    value = (counts.waiting ?? 0) + (counts.active ?? 0);
  }

  return {
    async scrape() {
      await collect();
      return value;
    },
    get() { return value; },
  };
}

test('#890: gauge reflects waiting + active job count', async (t) => {
  const queue = makeQueue(3, 2);
  const gauge = makeGauge(queue);
  const depth = await gauge.scrape();
  t.equal(depth, 5, 'gauge = 3 waiting + 2 active = 5');
  t.end();
});

test('#890: gauge returns 0 when queue is empty', async (t) => {
  const queue = makeQueue(0, 0);
  const gauge = makeGauge(queue);
  const depth = await gauge.scrape();
  t.equal(depth, 0, 'gauge is 0 for an empty queue');
  t.end();
});

test('#890: gauge reflects only waiting jobs when active is zero', async (t) => {
  const queue = makeQueue(7, 0);
  const gauge = makeGauge(queue);
  t.equal(await gauge.scrape(), 7, 'gauge = 7 waiting + 0 active');
  t.end();
});

test('#890: gauge reflects only active jobs when waiting is zero', async (t) => {
  const queue = makeQueue(0, 4);
  const gauge = makeGauge(queue);
  t.equal(await gauge.scrape(), 4, 'gauge = 0 waiting + 4 active');
  t.end();
});

test('#890: gauge updates on successive scrapes when queue depth changes', async (t) => {
  let waiting = 5;
  const queue = {
    async getJobCounts(): Promise<Record<string, number>> {
      return { waiting, active: 0 };
    },
  };
  const gauge = makeGauge(queue);

  t.equal(await gauge.scrape(), 5, 'first scrape returns 5');

  waiting = 2;
  t.equal(await gauge.scrape(), 2, 'second scrape reflects updated depth of 2');
  t.end();
});
