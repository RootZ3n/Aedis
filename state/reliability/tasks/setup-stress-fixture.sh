#!/usr/bin/env bash
# Setup script for the adversarial stress test suite
# Run this BEFORE executing the reliability harness

set -euo pipefail

FIXTURE=/tmp/aedis-stress-fixture
echo "=== Aedis Adversarial Stress Fixture Setup ==="
echo ""

# Create fixture if it doesn't exist
if [ ! -d "$FIXTURE" ]; then
  echo "[SETUP] Creating fixture at $FIXTURE"
  mkdir -p "$FIXTURE/src" "$FIXTURE/test" "$FIXTURE/.aedis"
else
  echo "[SETUP] Fixture already exists at $FIXTURE"
  mkdir -p "$FIXTURE/src" "$FIXTURE/test" "$FIXTURE/.aedis"
fi

# Create package.json if missing
if [ ! -f "$FIXTURE/package.json" ]; then
  cat > "$FIXTURE/package.json" << 'EOF'
{
  "name": "aedis-stress-fixture",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --experimental-vm-modules node_modules/.bin/jest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.3.0"
  }
}
EOF
  echo "[SETUP] Created package.json"
else
  echo "[SETUP] package.json already exists"
fi

# Create tsconfig if missing
if [ ! -f "$FIXTURE/tsconfig.json" ]; then
  cat > "$FIXTURE/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*", "test/**/*"]
}
EOF
  echo "[SETUP] Created tsconfig.json"
fi

# Create Jest config if missing
if [ ! -f "$FIXTURE/jest.config.js" ]; then
  cat > "$FIXTURE/jest.config.js" << 'EOF'
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
};
EOF
  echo "[SETUP] Created jest.config.js"
fi

# Create src/utils.ts
cat > "$FIXTURE/src/utils.ts" << 'EOF'
// Simple utils module for stress testing
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

export function isEven(n: number): boolean {
  return n % 2 === 0;
}

export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function validateEmail(email: string): boolean {
  return email.includes("@");
}

export class Stack<T> {
  private items: T[] = [];
  
  push(item: T): void {
    this.items.push(item);
  }
  
  pop(): T | undefined {
    return this.items.pop();
  }
  
  peek(): T | undefined {
    return this.items[this.items.length - 1];
  }
  
  get size(): number {
    return this.items.length;
  }
}

export async function fetchData(url: string): Promise<string> {
  return `data from ${url}`;
}
EOF
echo "[SETUP] Created src/utils.ts"

# Create test/utils.test.ts
cat > "$FIXTURE/test/utils.test.ts" << 'EOF'
import { add, subtract, divide, isEven, capitalize, validateEmail, Stack } from "../src/utils";

describe("utils", () => {
  test("add", () => expect(add(2, 3)).toBe(5));
  test("subtract", () => expect(subtract(5, 3)).toBe(2));
  test("isEven", () => expect(isEven(4)).toBe(true));
  test("capitalize", () => expect(capitalize("hello")).toBe("Hello"));
  test("validateEmail", () => expect(validateEmail("a@b.com")).toBe(true));
  test("Stack push/pop", () => {
    const s = new Stack<number>();
    s.push(1);
    s.push(2);
    expect(s.pop()).toBe(2);
  });
});
EOF
echo "[SETUP] Created test/utils.test.ts"

NEEDS_INSTALL=0
if [ ! -f "$FIXTURE/package-lock.json" ]; then
  NEEDS_INSTALL=1
elif [ ! -x "$FIXTURE/node_modules/.bin/jest" ]; then
  NEEDS_INSTALL=1
elif [ ! -x "$FIXTURE/node_modules/.bin/tsc" ]; then
  NEEDS_INSTALL=1
elif [ "$FIXTURE/package.json" -nt "$FIXTURE/package-lock.json" ]; then
  NEEDS_INSTALL=1
fi

if [ "$NEEDS_INSTALL" -eq 1 ]; then
  echo "[SETUP] Installing fixture dependencies"
  (
    cd "$FIXTURE"
    npm install --no-fund --no-audit
  )
else
  echo "[SETUP] Dependencies already installed"
fi

echo "[SETUP] Verifying fixture"
(
  cd "$FIXTURE"
  npm run typecheck >/dev/null
  npm test -- --runInBand >/dev/null
)

cat > "$FIXTURE/.aedis/bootstrap-status.txt" <<EOF
fixture=$FIXTURE
ready=true
verified_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
checks=typecheck,test
EOF

echo ""
echo "=== Fixture Ready ==="
echo "Verified: npm run typecheck && npm test -- --runInBand"
echo "Status: $FIXTURE/.aedis/bootstrap-status.txt"
echo "Run: aedis reliability run state/reliability/tasks/stress-suite.json --label adversarial-v1"
