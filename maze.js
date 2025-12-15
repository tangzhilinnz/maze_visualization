// ==========================================
// 1. ENUMS & CONSTANTS
// ==========================================

const Direction = {
    North: 0,
    East: 1,
    South: 2,
    West: 3,
    Uninitialized: 4
};

const InternalBit = {
    EAST_BIT: 1,
    SOUTH_BIT: 2,
    VISITED_BIT: 4,
    PATH_BIT: 8,

    PARENT_NORTH: 16,
    PARENT_EAST: 32,
    PARENT_SOUTH: 64,
    PARENT_WEST: 128,
    PARENT_MASK: 240,

    ON_STACK_BIT: 256,

    // MT - Branch Logic
    DEAD_N: 0x1000,
    DEAD_E: 0x2000,
    DEAD_S: 0x4000,
    DEAD_W: 0x8000,

    OCCUPIED_N: 0x10000,
    OCCUPIED_E: 0x20000,
    OCCUPIED_S: 0x40000,
    OCCUPIED_W: 0x80000,

    // Team Ownership
    VISITED_TB: 0x100000,
    VISITED_BT: 0x200000,

    // Dead State (Dark Gray) - ONLY for True Junctions
    DEAD_JUNCTION_BIT: 0x400000,

    // MT_M1 Specific
    PRUNED_BIT: 0x800000
};

// ==========================================
// 2. HELPER CLASSES
// ==========================================

class Position {
    constructor(row = 0, col = 0) {
        this.row = row;
        this.col = col;
    }
    eq(other) { return this.row === other.row && this.col === other.col; }
    ne(other) { return !this.eq(other); }
    // JS objects are references, so we need a key for Maps
    toKey() { return `${this.row},${this.col}`; }

    move(dir) {
        if (dir === Direction.North) return new Position(this.row - 1, this.col);
        if (dir === Direction.South) return new Position(this.row + 1, this.col);
        if (dir === Direction.East) return new Position(this.row, this.col + 1);
        if (dir === Direction.West) return new Position(this.row, this.col - 1);
        return this;
    }
}

function reverseDir(d) {
    if (d === Direction.North) return Direction.South;
    if (d === Direction.South) return Direction.North;
    if (d === Direction.East) return Direction.West;
    if (d === Direction.West) return Direction.East;
    return Direction.Uninitialized;
}

// Helper for Deque (Python) -> Array (JS)
// Using standard array for simplicity, shift() is O(n) but acceptable for JS arrays < 100k elements in V8
class Deque {
    constructor(items = []) { this.q = items; }
    append(item) { this.q.push(item); }
    popleft() { return this.q.shift(); }
    get length() { return this.q.length; }
}

// ==========================================
// 4. MAZE & SHARED DATA
// ==========================================

class Maze {
    constructor() {
        this.width = 0;
        this.height = 0;
        this.poMazeData = []; // Will be Int32Array
        this.visitOrder = []; // Will be Int32Array
        this.thread_ownership = new Map();
    }

    async Load(url) {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const view = new DataView(buffer);
        let offset = 0;

        // Python: struct.unpack('iii', header_bytes)
        this.width = view.getInt32(offset, true); offset += 4;
        this.height = view.getInt32(offset, true); offset += 4;
        const solvable = view.getInt32(offset, true); offset += 4;

        const size = this.width * this.height;
        this.poMazeData = new Int32Array(size);
        this.visitOrder = new Int32Array(size).fill(-1);

        // Python Logic: read 4 bytes (int), parse 16 cells (2 bits each)
        for (let row = 0; row < this.height; row++) {
            let col = 0;
            while (col < this.width) {
                if (offset >= buffer.byteLength) break;
                // int_bytes = f.read(4)
                let bits = view.getInt32(offset, true); offset += 4;

                for (let i = 0; i < 16; i++) {
                    if (col >= this.width) break;

                    const east = bits & 1;
                    const south = (bits >> 1) & 1;

                    const idx = row * this.width + col;
                    let val = 0;
                    if (east) val |= InternalBit.EAST_BIT;
                    if (south) val |= InternalBit.SOUTH_BIT;

                    this.poMazeData[idx] = val;

                    bits >>= 2;
                    col += 1;
                }
            }
        }
    }

    Reset() {
        const mask = ~(InternalBit.VISITED_BIT |
            InternalBit.PATH_BIT |
            InternalBit.PARENT_MASK |
            InternalBit.ON_STACK_BIT |
            InternalBit.PRUNED_BIT |
            0xFFFF000);

        for (let i = 0; i < this.poMazeData.length; i++) {
            this.poMazeData[i] &= mask;
            this.visitOrder[i] = -1;
        }
        this.thread_ownership.clear();
    }

    _cellIndex(pos) { return pos.row * this.width + pos.col; }

    setVisitOrder(pos, order) {
        this.visitOrder[this._cellIndex(pos)] = order;
    }

    getVisitOrder(pos) {
        return this.visitOrder[this._cellIndex(pos)];
    }

    getStart() { return new Position(0, Math.floor(this.width / 2)); }
    getEnd() { return new Position(this.height - 1, Math.floor(this.width / 2)); }

    getCell(pos) {
        if (pos.row >= 0 && pos.row < this.height && pos.col >= 0 && pos.col < this.width) {
            return this.poMazeData[this._cellIndex(pos)];
        }
        return 0;
    }

    setCell(pos, value) {
        this.poMazeData[this._cellIndex(pos)] = value;
    }

    _hasFlag(pos, val) { return (this.getCell(pos) & val) !== 0; }
    _setFlag(pos, val) { this.setCell(pos, this.getCell(pos) | val); }
    _clearFlag(pos, val) { this.setCell(pos, this.getCell(pos) & ~val); }

    canMove(pos, direction) {
        if (direction === Direction.North) {
            if (pos.row === 0) return false;
            return !this._hasFlag(pos.move(Direction.North), InternalBit.SOUTH_BIT);
        } else if (direction === Direction.South) {
            if (pos.row === this.height - 1) return false;
            return !this._hasFlag(pos, InternalBit.SOUTH_BIT);
        } else if (direction === Direction.East) {
            if (pos.col === this.width - 1) return false;
            return !this._hasFlag(pos, InternalBit.EAST_BIT);
        } else if (direction === Direction.West) {
            if (pos.col === 0) return false;
            return !this._hasFlag(pos.move(Direction.West), InternalBit.EAST_BIT);
        }
        return false;
    }

    isJunction(pos) {
        let exits = 0;
        if (this.canMove(pos, Direction.North)) exits++;
        if (this.canMove(pos, Direction.South)) exits++;
        if (this.canMove(pos, Direction.East)) exits++;
        if (this.canMove(pos, Direction.West)) exits++;
        return exits > 2;
    }

    // --- Standard BFS/DFS Helpers ---
    setDirectionRouteBT(pos, parent_dir) {
        let val = this.getCell(pos);
        val &= ~InternalBit.PARENT_MASK;
        val |= InternalBit.VISITED_BIT;
        if (parent_dir === Direction.North) val |= InternalBit.PARENT_NORTH;
        else if (parent_dir === Direction.East) val |= InternalBit.PARENT_EAST;
        else if (parent_dir === Direction.South) val |= InternalBit.PARENT_SOUTH;
        else if (parent_dir === Direction.West) val |= InternalBit.PARENT_WEST;
        this.setCell(pos, val);
    }

    getDirectionRouteBT(pos) {
        const val = this.getCell(pos);
        if (val & InternalBit.PARENT_NORTH) return Direction.North;
        if (val & InternalBit.PARENT_EAST) return Direction.East;
        if (val & InternalBit.PARENT_SOUTH) return Direction.South;
        if (val & InternalBit.PARENT_WEST) return Direction.West;
        return Direction.Uninitialized;
    }

    markPath(pos) {
        this._setFlag(pos, InternalBit.PATH_BIT);
    }

    markOnStack(pos, on_stack) {
        if (on_stack) this._setFlag(pos, InternalBit.ON_STACK_BIT);
        else this._clearFlag(pos, InternalBit.ON_STACK_BIT);
    }

    // --- MT SPECIFIC BIT OPERATIONS ---

    checkBranchDead(pos, dir) {
        let bit = 0;
        if (dir === Direction.North) bit = InternalBit.DEAD_N;
        else if (dir === Direction.East) bit = InternalBit.DEAD_E;
        else if (dir === Direction.South) bit = InternalBit.DEAD_S;
        else if (dir === Direction.West) bit = InternalBit.DEAD_W;
        return this._hasFlag(pos, bit);
    }

    setBranchDeadFromOrigin(pos, dir) {
        let bit = 0;
        if (dir === Direction.North) bit = InternalBit.DEAD_N;
        else if (dir === Direction.East) bit = InternalBit.DEAD_E;
        else if (dir === Direction.South) bit = InternalBit.DEAD_S;
        else if (dir === Direction.West) bit = InternalBit.DEAD_W;
        this._setFlag(pos, bit);
    }

    checkBranchOccupied(pos, dir) {
        let bit = 0;
        if (dir === Direction.North) bit = InternalBit.OCCUPIED_N;
        else if (dir === Direction.East) bit = InternalBit.OCCUPIED_E;
        else if (dir === Direction.South) bit = InternalBit.OCCUPIED_S;
        else if (dir === Direction.West) bit = InternalBit.OCCUPIED_W;
        return this._hasFlag(pos, bit);
    }

    setBranchOccupied(pos, dir) {
        let bit = 0;
        if (dir === Direction.North) bit = InternalBit.OCCUPIED_N;
        else if (dir === Direction.East) bit = InternalBit.OCCUPIED_E;
        else if (dir === Direction.South) bit = InternalBit.OCCUPIED_S;
        else if (dir === Direction.West) bit = InternalBit.OCCUPIED_W;
        this._setFlag(pos, bit);
    }

    markVisitedTeam(pos, is_tb) {
        if (is_tb) this._setFlag(pos, InternalBit.VISITED_TB);
        else this._setFlag(pos, InternalBit.VISITED_BT);
    }

    markDeadJunction(pos) {
        this._clearFlag(pos, InternalBit.VISITED_TB);
        this._clearFlag(pos, InternalBit.VISITED_BT);
        this._setFlag(pos, InternalBit.DEAD_JUNCTION_BIT);
    }

    unmarkVisitedTeam(pos) {
        this._clearFlag(pos, InternalBit.VISITED_TB);
        this._clearFlag(pos, InternalBit.VISITED_BT);
        // === FIX: ALSO CLEAR THE GENERIC VISITED BIT TO REMOVE GREY TRAIL ===
        this._clearFlag(pos, InternalBit.VISITED_BIT);
    }

    isVisitedByTeam(pos, is_tb) {
        if (is_tb) return this._hasFlag(pos, InternalBit.VISITED_TB);
        else return this._hasFlag(pos, InternalBit.VISITED_BT);
    }

    setThreadOwner(pos, thread_id) {
        this.thread_ownership.set(this._cellIndex(pos), thread_id);
    }

    getThreadOwner(pos) {
        const val = this.thread_ownership.get(this._cellIndex(pos));
        return val !== undefined ? val : -1;
    }

    // --- MT_M1 Helper ---
    markPruned(pos) {
        this._setFlag(pos, InternalBit.PRUNED_BIT);
    }

    isPruned(pos) {
        return this._hasFlag(pos, InternalBit.PRUNED_BIT);
    }

    getAvailableMovesNoPruned(pos) {
        const moves = [];
        const dirs = [Direction.North, Direction.South, Direction.East, Direction.West];
        for (let d of dirs) {
            if (this.canMove(pos, d)) {
                const n_pos = pos.move(d);
                if (!this.isPruned(n_pos)) {
                    moves.push(d);
                }
            }
        }
        return moves;
    }
}

// --- Ported Logic ---

class Branches {
    constructor(maze, pos, threadID) {
        this.directions = [Direction.Uninitialized, Direction.Uninitialized, Direction.Uninitialized, Direction.Uninitialized];
        this.count = 0;
        this.index = threadID & 3;

        let idx = 0;
        const dirs = [Direction.North, Direction.East, Direction.South, Direction.West];
        for (let d of dirs) {
            if (maze.canMove(pos, d)) {
                this.directions[idx] = d;
                this.count += 1;
            } else {
                this.directions[idx] = Direction.Uninitialized;
            }
            idx += 1;
        }
    }

    remove(d) {
        for (let i = 0; i < 4; i++) {
            if (this.directions[i] === d) {
                this.directions[i] = Direction.Uninitialized;
                this.count -= 1;
                return;
            }
        }
    }

    getNextThreads(at, maze) {
        if (this.count === 0) return Direction.Uninitialized;

        let fallbackIndex = -1;

        for (let i = 0; i < 4; i++) {
            this.index = (this.index + 1) & 3;
            const d = this.directions[this.index];

            if (d === Direction.Uninitialized) continue;

            if (maze.checkBranchDead(at, d)) {
                this.directions[this.index] = Direction.Uninitialized;
                this.count -= 1;
                if (this.count === 0) return Direction.Uninitialized;
                continue;
            }

            if (fallbackIndex === -1) fallbackIndex = this.index;

            if (maze.checkBranchOccupied(at, d)) {
                continue;
            }

            maze.setBranchOccupied(at, d);
            return d;
        }

        if (fallbackIndex !== -1) {
            this.index = fallbackIndex;
            return this.directions[this.index];
        }

        return Direction.Uninitialized;
    }

    popCurrThreads(at, maze) {
        const d = this.directions[this.index];
        if (d !== Direction.Uninitialized) {
            maze.setBranchDeadFromOrigin(at, d);
            this.directions[this.index] = Direction.Uninitialized;
            this.count -= 1;
        }
        return d;
    }

    getNext() {
        if (this.count === 0) return Direction.Uninitialized;
        for (let i = 0; i < 4; i++) {
            this.index = (this.index + 1) & 3;
            if (this.directions[this.index] !== Direction.Uninitialized) {
                return this.directions[this.index];
            }
        }
        return Direction.Uninitialized;
    }

    size() { return this.count; }
}

class Junction {
    constructor(at, came_from, branches, isOverlap = false) {
        this.at = at;
        this.came_from = came_from;
        this.branches = branches;
        this.isOverlap = isOverlap;
    }
}

// ==========================================
// 5. SOLVERS
// ==========================================

class BFSSolver {
    constructor(maze) {
        this.maze = maze;
    }
    *solve_step_by_step() {
        const start = this.maze.getStart();
        const end = this.maze.getEnd();
        const q = new Deque([start]);
        let visit_counter = 0;
        this.maze.setVisitOrder(start, visit_counter);
        visit_counter += 1;
        this.maze.setDirectionRouteBT(start, Direction.Uninitialized);
        let found = false;

        while (q.length > 0) {
            yield "SEARCHING";
            const cur = q.popleft();
            if (cur.eq(end)) {
                found = true;
                break;
            }
            const dirs = [Direction.South, Direction.West, Direction.East, Direction.North];
            for (let d of dirs) {
                if (this.maze.canMove(cur, d)) {
                    const nextPos = cur.move(d);
                    if (this.maze.getVisitOrder(nextPos) === -1) {
                        let parent = Direction.Uninitialized;
                        if (d === Direction.North) parent = Direction.South;
                        else if (d === Direction.South) parent = Direction.North;
                        else if (d === Direction.East) parent = Direction.West;
                        else if (d === Direction.West) parent = Direction.East;

                        this.maze.setDirectionRouteBT(nextPos, parent);
                        this.maze.setVisitOrder(nextPos, visit_counter);
                        visit_counter += 1;
                        q.append(nextPos);
                    }
                }
            }
        }
        if (found) {
            let curr = end;
            while (true) {
                this.maze.markPath(curr);
                yield "BACKTRACKING";
                if (curr.eq(start)) break;
                const parent_dir = this.maze.getDirectionRouteBT(curr);
                if (parent_dir === Direction.Uninitialized) break;
                curr = curr.move(parent_dir);
            }
            yield "FINISHED";
        } else {
            yield "NO_SOLUTION";
        }
    }
}

class DFSSolver {
    constructor(maze) {
        this.maze = maze;
    }
    *solve_step_by_step() {
        const start = this.maze.getStart();
        const end = this.maze.getEnd();
        // Stack holds [position, parent_dir]
        const stack = [[start, Direction.Uninitialized]];
        let visit_counter = 0;
        this.maze.setVisitOrder(start, visit_counter);
        visit_counter += 1;
        this.maze.markOnStack(start, true);
        this.maze.setDirectionRouteBT(start, Direction.Uninitialized);
        let found = false;

        while (stack.length > 0) {
            const [curr, _] = stack[stack.length - 1];
            yield "SEARCHING";
            if (curr.eq(end)) {
                found = true;
                break;
            }
            let moved = false;
            const dirs = [Direction.South, Direction.East, Direction.West, Direction.North];
            for (let d of dirs) {
                if (this.maze.canMove(curr, d)) {
                    const nextPos = curr.move(d);
                    if (this.maze.getVisitOrder(nextPos) === -1) {
                        this.maze.setVisitOrder(nextPos, visit_counter);
                        visit_counter += 1;
                        this.maze.markOnStack(nextPos, true);
                        let parent = Direction.Uninitialized;
                        if (d === Direction.North) parent = Direction.South;
                        else if (d === Direction.South) parent = Direction.North;
                        else if (d === Direction.East) parent = Direction.West;
                        else if (d === Direction.West) parent = Direction.East;

                        this.maze.setDirectionRouteBT(nextPos, parent);
                        stack.push([nextPos, parent]);
                        moved = true;
                        break;
                    }
                }
            }
            if (!moved) {
                if (stack.length > 0) {
                    const [p_top, __] = stack[stack.length - 1];
                    let has_opts = false;
                    for (let d of [Direction.South, Direction.East, Direction.West, Direction.North]) {
                        if (this.maze.canMove(p_top, d)) {
                            const np = p_top.move(d);
                            if (this.maze.getVisitOrder(np) === -1) {
                                has_opts = true;
                                break;
                            }
                        }
                    }

                    if (!has_opts) {
                        const [p, ___] = stack.pop();
                        this.maze.markOnStack(p, false);

                        // === FIX: CLEAR GREY TRAIL ===
                        this.maze._clearFlag(p, InternalBit.VISITED_BIT);

                        if (this.maze.isJunction(p)) {
                            this.maze.markDeadJunction(p);
                        }
                    }
                }
            }
        }

        if (found) {
            let curr = end;
            while (true) {
                this.maze.markPath(curr);
                yield "BACKTRACKING";
                if (curr.eq(start)) break;
                const parent_dir = this.maze.getDirectionRouteBT(curr);
                if (parent_dir === Direction.Uninitialized) break;
                curr = curr.move(parent_dir);
            }
            yield "FINISHED";
        } else {
            yield "NO_SOLUTION";
        }
    }
}

// --- MULTI-THREADED LOGIC (M2) ---

class DFSThread {
    constructor(threadID, is_tb, start_pos, maze) {
        this.id = threadID;
        this.is_tb = is_tb;
        this.stack = [];
        this.maze = maze;
        this.finished = false;

        const branches = new Branches(maze, start_pos, threadID);
        this.stack.push(new Junction(start_pos, Direction.Uninitialized, branches));

        this.state = 0;
        this.target_pos = null;
        this.corridor_dir = Direction.Uninitialized;
        this.backtrack_target = null;
    }

    step() {
        if (this.finished || this.stack.length === 0) return 'DEAD';

        // --- STATE 0: Junction Processing ---
        if (this.state === 0) {
            const junc = this.stack[this.stack.length - 1];

            // Check collision BEFORE writing to map, otherwise we overwrite the evidence
            if (this.is_tb) {
                if (junc.at.eq(this.maze.getEnd())) return 'FOUND_TARGET';
                if (this.maze.isVisitedByTeam(junc.at, false)) return 'FOUND_TARGET';
            } else {
                if (this.maze.isVisitedByTeam(junc.at, true)) return 'FOUND_TARGET';
            }

            this.maze.markVisitedTeam(junc.at, this.is_tb);
            this.maze.setThreadOwner(junc.at, this.id);

            let d = Direction.Uninitialized;
            if (junc.branches.size() > 0) {
                d = junc.branches.getNextThreads(junc.at, this.maze);
            }

            if (d === Direction.Uninitialized) {
                this.stack.pop();

                // Check for TRUE junction
                if (this.maze.isJunction(junc.at)) {
                    this.maze.markDeadJunction(junc.at);
                } else {
                    this.maze.unmarkVisitedTeam(junc.at);
                }

                if (this.stack.length > 0) {
                    const parent = this.stack[this.stack.length - 1];
                    parent.branches.popCurrThreads(parent.at, this.maze);

                    this.backtrack_target = parent.at;
                    this.target_pos = junc.at;
                    this.state = 2;
                } else {
                    return 'DEAD';
                }
                return 'CONTINUE';
            }

            this.state = 1;
            this.corridor_dir = d;
            this.target_pos = junc.at;
            return 'CONTINUE';
        }

        // --- STATE 1: Corridor Movement ---
        else if (this.state === 1) {
            const next_p = this.target_pos.move(this.corridor_dir);
            const parent_rev = reverseDir(this.corridor_dir);

            // === CRITICAL FIX: Check Collision BEFORE Overwriting Ownership ===
            let collision_found = false;
            if (this.is_tb) {
                if (next_p.eq(this.maze.getEnd()) || this.maze.isVisitedByTeam(next_p, false)) {
                    collision_found = true;
                }
            } else {
                if (this.maze.isVisitedByTeam(next_p, true)) {
                    collision_found = true;
                }
            }

            if (collision_found) {
                // Do NOT setThreadOwner here. Leave the existing owner (the other team) 
                // so the solver can find the correct stack.
                this.target_pos = next_p;
                // We do add a dummy junction to represent our arrival at the collision
                this.stack.push(new Junction(next_p, parent_rev, new Branches(this.maze, next_p, this.id)));
                return 'FOUND_TARGET';
            }

            // No collision, safe to claim
            this.maze.markVisitedTeam(next_p, this.is_tb);
            this.maze.setThreadOwner(next_p, this.id);
            this.maze.setDirectionRouteBT(next_p, parent_rev);
            this.target_pos = next_p;

            const branches = new Branches(this.maze, next_p, this.id);
            branches.remove(parent_rev);

            if (branches.size() !== 1) {
                this.stack.push(new Junction(next_p, parent_rev, branches));
                this.state = 0;
            } else {
                this.corridor_dir = branches.getNext();
            }
            return 'CONTINUE';
        }

        // --- STATE 2: Backtracking ---
        else if (this.state === 2) {
            if (!this.maze.isJunction(this.target_pos)) {
                this.maze.unmarkVisitedTeam(this.target_pos);
            }

            if (this.target_pos.eq(this.backtrack_target)) {
                this.state = 0;
                return 'CONTINUE';
            }

            const parent_dir = this.maze.getDirectionRouteBT(this.target_pos);
            if (parent_dir === Direction.Uninitialized) {
                this.state = 0;
                return 'CONTINUE';
            }

            this.target_pos = this.target_pos.move(parent_dir);
            return 'CONTINUE';
        }

        return 'DEAD';
    }
}

class MTSolver {
    constructor(maze) {
        this.maze = maze;
        this.threads = [];
    }

    *solve_step_by_step() {
        const start = this.maze.getStart();
        const end = this.maze.getEnd();

        this.threads = [];
        for (let i = 0; i < 3; i++) {
            this.threads.push(new DFSThread(i, true, start, this.maze));
        }
        for (let i = 0; i < 3; i++) {
            this.threads.push(new DFSThread(i + 3, false, end, this.maze));
        }

        this.maze.markVisitedTeam(start, true);
        this.maze.setThreadOwner(start, 0);

        this.maze.markVisitedTeam(end, false);
        this.maze.setThreadOwner(end, 3);

        let found = false;
        let collision_pos = null;

        while (!found) {
            let active_threads = 0;
            for (let t of this.threads) {
                if (t.finished) continue;

                const res = t.step();
                if (res === 'DEAD') {
                    t.finished = true;
                } else if (res === 'FOUND_TARGET') {
                    found = true;
                    if (t.stack.length > 0) {
                        collision_pos = t.target_pos;
                    }
                    break;
                } else {
                    active_threads += 1;
                }
            }

            yield "SEARCHING";
            if (active_threads === 0 && !found) {
                break;
            }
        }

        if (found && collision_pos) {
            // === PATH RECONSTRUCTION ===

            // --- PART 1: TOP-BOTTOM (Standard Backtracking) ---
            const path_tb = [];
            let curr_tb = collision_pos;

            // Safety: Ensure we are on a TB cell or neighbor
            if (!this.maze.isVisitedByTeam(curr_tb, true)) {
                for (let d of [Direction.North, Direction.East, Direction.South, Direction.West]) {
                    const n = curr_tb.move(d);
                    if (this.maze.isVisitedByTeam(n, true)) {
                        curr_tb = n;
                        break;
                    }
                }
            }

            let temp = curr_tb;
            while (!temp.eq(start)) {
                path_tb.push(temp);
                const parent_dir = this.maze.getDirectionRouteBT(temp);
                if (parent_dir === Direction.Uninitialized) break;
                temp = temp.move(parent_dir);
            }
            path_tb.push(start);

            for (let i = path_tb.length - 1; i >= 0; i--) {
                this.maze.markPath(path_tb[i]);
                yield "BACKTRACKING";
            }

            // --- PART 2: BOTTOM-TOP (Segment-Based Reconstruction) ---

            // 1. Identify the BT Thread
            let bt_thread = null;

            // Try to find owner at collision or neighbors
            const check_list = [collision_pos];
            for (let d of [Direction.North, Direction.East, Direction.South, Direction.West]) {
                check_list.push(collision_pos.move(d));
            }

            for (let pos of check_list) {
                if (this.maze.isVisitedByTeam(pos, false)) {
                    const tid = this.maze.getThreadOwner(pos);
                    if (tid >= 3) {
                        bt_thread = this.threads[tid];
                        break;
                    }
                }
            }

            if (bt_thread && bt_thread.stack.length > 0) {
                // 2. Sync with Stack
                // We expect the collision point to be the tip of the stack (or very close)
                // because the thread pushes a dummy junction upon collision.
                let stack_idx = bt_thread.stack.length - 1;

                // Verify and adjust if needed
                if (!bt_thread.stack[stack_idx].at.eq(collision_pos)) {
                    // Search for the collision point in the stack
                    for (let i = bt_thread.stack.length - 1; i >= 0; i--) {
                        if (bt_thread.stack[i].at.eq(collision_pos)) {
                            stack_idx = i;
                            break;
                        }
                    }
                }

                let curr = bt_thread.stack[stack_idx].at;

                // 3. Walk Segment by Segment
                // We iterate backwards from the Tip (Collision) down to the Root (End)
                // i corresponds to the 'Current Junction'. i-1 is the 'Goal Junction'.

                while (stack_idx > 0) {
                    const node_curr = bt_thread.stack[stack_idx];
                    const node_goal = bt_thread.stack[stack_idx - 1];

                    // A. Mark current node
                    this.maze.markPath(curr);
                    yield "BACKTRACKING";

                    // B. Take the first step (The Jump)
                    // came_from points BACK towards the parent (node_goal)
                    let jump_dir = node_curr.came_from;
                    curr = curr.move(jump_dir);

                    // C. Walk the Corridor
                    // Keep moving until we hit the goal node
                    while (!curr.eq(node_goal.at)) {
                        this.maze.markPath(curr);
                        yield "BACKTRACKING";

                        let found_next = false;

                        // Note: We need to track where we came from to avoid bouncing back.
                        // Since 'jump_dir' brought us here, reverseDir(jump_dir) is "back".
                        // We update 'jump_dir' as we move.

                        const back_dir = reverseDir(jump_dir);

                        // Priority Check: Are we next to the goal?
                        for (let d of [Direction.North, Direction.East, Direction.South, Direction.West]) {
                            if (curr.move(d).eq(node_goal.at)) {
                                jump_dir = d;
                                curr = curr.move(d);
                                found_next = true;
                                break;
                            }
                        }

                        if (found_next) continue;

                        // Regular Step
                        for (let d of [Direction.North, Direction.East, Direction.South, Direction.West]) {
                            if (d === back_dir) continue;
                            if (!this.maze.canMove(curr, d)) continue;

                            const n = curr.move(d);
                            // Strict Owner Check
                            if (this.maze.getThreadOwner(n) === bt_thread.id && this.maze.isVisitedByTeam(n, false)) {
                                jump_dir = d;
                                curr = n;
                                found_next = true;
                                break;
                            }
                        }

                        if (!found_next) {
                            // Fallback for rare race conditions: Allow any BT visited cell
                            for (let d of [Direction.North, Direction.East, Direction.South, Direction.West]) {
                                if (d === back_dir) continue;
                                if (!this.maze.canMove(curr, d)) continue;
                                const n = curr.move(d);
                                if (this.maze.isVisitedByTeam(n, false)) {
                                    jump_dir = d;
                                    curr = n;
                                    found_next = true;
                                    break;
                                }
                            }

                            if (!found_next) {
                                console.log("Error: Lost in corridor reconstruction.");
                                break;
                            }
                        }
                    }

                    // Loop finished (curr == node_goal.at). 
                    // Prepare for next segment.
                    stack_idx -= 1;
                }

                // Mark the final node (The Maze End)
                this.maze.markPath(end);

            } else {
                console.log("Error: Could not find valid BT Thread stack.");
            }

            yield "FINISHED";
        } else {
            yield "NO_SOLUTION";
        }
    }
}

// ==========================================
// 6. MT_M1 SOLVER
// ==========================================

class PruneThread {
    constructor(tid, maze, row_start, row_end, in_q, out_qs) {
        this.id = tid;
        this.maze = maze;
        this.row_start = row_start;
        this.row_end = row_end;
        this.in_q = in_q;
        this.out_qs = out_qs; // List of output queues [Top, Bottom] or just neighbors
        this.stack = [];
        this.phase = 'SCAN';
        this.iter_row = row_start;
        this.iter_col = 0;
        this.finished = false;
    }

    step() {
        if (this.finished) return;

        // 1. SCAN PHASE
        if (this.phase === 'SCAN') {
            // Scan a chunk of cells per frame to avoid lag, but here we do it incrementally
            // To visualize slowly, we do one row or a few cells per step.
            // Let's do one row per step to be visible
            for (let k = 0; k < this.maze.width; k++) {
                if (this.iter_col >= this.maze.width) {
                    this.iter_col = 0;
                    this.iter_row += 1;
                }

                if (this.iter_row >= this.row_end) {
                    this.phase = 'PRUNE';
                    return;
                }

                const pos = new Position(this.iter_row, this.iter_col);
                // Skip Start/End
                if (pos.eq(this.maze.getStart()) || pos.eq(this.maze.getEnd())) {
                    this.iter_col += 1;
                    continue;
                }

                const moves = this.maze.getAvailableMovesNoPruned(pos);
                if (moves.length <= 1) {
                    this.stack.push(pos);
                }

                this.iter_col += 1;
            }
        }

        // 2. PRUNE PHASE
        else if (this.phase === 'PRUNE') {

            // Process incoming queue from neighbors
            while (this.in_q.length > 0) {
                const p_pos = this.in_q.popleft();
                this.stack.push(p_pos);
            }

            if (this.stack.length === 0) {
                // No work, but keep alive waiting for neighbors
                return;
            }

            // Process stack (do a few per frame)
            // C++ logic: while (!stackDFS.empty())
            let processed_count = 0;
            // === MODIFICATION HERE: Change 5 to 1 for gradual single-step effect ===
            while (this.stack.length > 0 && processed_count < 1) {
                const pos = this.stack.pop();
                processed_count += 1;

                if (this.maze.isPruned(pos)) continue;

                this.maze.markPruned(pos);
                this.maze.setThreadOwner(pos, this.id); // For coloring

                // Get moves ignoring currently pruned cells
                const moves = this.maze.getAvailableMovesNoPruned(pos);

                if (moves.length === 1) {
                    const d = moves[0];
                    const neighbor = pos.move(d);

                    if (neighbor.eq(this.maze.getStart()) || neighbor.eq(this.maze.getEnd())) {
                        continue;
                    }

                    const n_moves = this.maze.getAvailableMovesNoPruned(neighbor);

                    // Logic says: if neighbors moves <= 1 (after pruning current), it becomes dead

                    if (n_moves.length <= 1) {
                        // Check boundary
                        if (neighbor.row < this.row_start) {
                            // Send to Top Neighbor
                            if (this.out_qs[0] !== null) this.out_qs[0].append(neighbor);
                        } else if (neighbor.row >= this.row_end) {
                            // Send to Bottom Neighbor
                            if (this.out_qs[1] !== null) this.out_qs[1].append(neighbor);
                        } else {
                            this.stack.push(neighbor);
                        }
                    }
                }
            }
        }
    }
}

class WalkThreadTB {
    constructor(maze, solve_list) {
        this.maze = maze;
        this.solve_list = solve_list; // Shared list to store result
        this.curr = maze.getStart();
        this.came_from = Direction.Uninitialized;
        this.finished = false;
        this.found = false;
        this.overlap = null;
    }

    step(first_exit_ref) {
        if (this.finished) return;

        const target = this.maze.getEnd();

        // Check if BT thread reached here or we are overlapping
        if (this.maze.getDirectionRouteBT(this.curr) !== Direction.Uninitialized) {
            this.overlap = this.curr;
            this.finished = true;
            return;
        }

        if (this.curr.eq(target)) {
            this.found = true;
            first_exit_ref.val = true;
            this.finished = true;
            return;
        }

        const moves = this.maze.getAvailableMovesNoPruned(this.curr);

        // Remove came_from
        if (this.came_from !== Direction.Uninitialized) {
            const index = moves.indexOf(this.came_from);
            if (index > -1) moves.splice(index, 1);
        }

        let go_to = Direction.Uninitialized;

        if (moves.length === 1) {
            go_to = moves[0];
            this.solve_list.push(go_to);
            this.curr = this.curr.move(go_to);
            this.overlap = this.curr;
            this.came_from = reverseDir(go_to);

            // Visual marker
            this.maze.markVisitedTeam(this.curr, true);

        } else if (moves.length > 1) {
            // Wait for pruning to reduce choices
            return;
        } else if (moves.length === 0) {
            // Dead end (shouldn't happen if pruning is correct)
            this.finished = true;
        }
    }
}

class BFSThreadBT {
    constructor(maze) {
        this.maze = maze;
        this.q = new Deque([maze.getEnd()]);
        this.maze.setDirectionRouteBT(maze.getEnd(), Direction.Uninitialized);
        this.finished = false;
        this.found = false;
    }

    step(first_exit_ref) {
        if (this.finished || first_exit_ref.val) {
            this.finished = true;
            return;
        }

        const end_node = this.maze.getStart();

        // Process a few nodes per frame
        let steps = 0;
        while (this.q.length > 0 && steps < 2) {
            steps += 1;
            const cur = this.q.popleft();

            if (this.maze.isPruned(cur)) continue;

            if (cur.eq(end_node)) {
                first_exit_ref.val = true;
                this.found = true;
                this.finished = true;
                return;
            }

            const came_from = this.maze.getDirectionRouteBT(cur);

            for (let d of [Direction.South, Direction.West, Direction.East, Direction.North]) {
                // Check valid move
                if (this.maze.canMove(cur, d)) {
                    const nextPos = cur.move(d);

                    if (this.maze.isPruned(nextPos)) continue;

                    if (this.maze.getDirectionRouteBT(nextPos) === Direction.Uninitialized) {
                        // Mark parent
                        const parent = reverseDir(d);
                        this.maze.setDirectionRouteBT(nextPos, parent);
                        this.q.append(nextPos);

                        // Visual
                        this.maze.markVisitedTeam(nextPos, false);
                    }
                }
            }
        }
    }
}

class MT_M1_Solver {
    constructor(maze) {
        this.maze = maze;
        this.pruners = [];
        this.walker = null;
        this.bfs = null;
        this.solve_list = [];
        this.first_exit = { val: false }; // Reference wrapper

        // Setup Pruners
        const N = 4;
        const chunk = Math.floor(maze.height / N);
        const remainder = maze.height % N;

        const queues = [];
        for (let i = 0; i < N; i++) queues.push(new Deque()); // In-queues for each thread

        for (let i = 0; i < N; i++) {
            const row_start = i * chunk + Math.min(i, remainder);
            const row_end = (i + 1) * chunk + Math.min(i + 1, remainder);

            // Neighbors queues: [Top, Bottom]
            const out_qs = [null, null];
            if (i > 0) out_qs[0] = queues[i - 1];
            if (i < N - 1) out_qs[1] = queues[i + 1];

            this.pruners.push(new PruneThread(i, maze, row_start, row_end, queues[i], out_qs));
        }

        this.walker = new WalkThreadTB(maze, this.solve_list);
        this.bfs = new BFSThreadBT(maze);
    }

    *solve_step_by_step() {

        // Main Loop: Runs as long as solution isn't found and searchers are active
        while (!this.first_exit.val && (!this.walker.finished || !this.bfs.finished)) {

            // 1. Step Pruners (Concurrent)
            for (let p of this.pruners) {
                p.step();
            }

            // 2. Step Walker (Concurrent)
            this.walker.step(this.first_exit);

            // 3. Step BFS (Concurrent)
            this.bfs.step(this.first_exit);

            if (this.walker.finished && this.walker.overlap) {
                break;
            }

            yield "SEARCHING";
        }

        // Reconstruction
        // 1. TB Path part
        let curr = this.maze.getStart();
        // Draw TB part
        for (let d of this.solve_list) {
            this.maze.markPath(curr);
            curr = curr.move(d);
            yield "BACKTRACKING";
        }

        // Draw remaining from Overlap to End using BT hints
        while (!curr.eq(this.maze.getEnd())) {
            this.maze.markPath(curr);
            const d = this.maze.getDirectionRouteBT(curr);
            if (d === Direction.Uninitialized) break;
            curr = curr.move(d);
            yield "BACKTRACKING";
        }

        this.maze.markPath(this.maze.getEnd());
        yield "FINISHED";
    }
}

// ==========================================
// MAIN UI INTERACTION
// ==========================================

const canvas = document.getElementById('mazeCanvas');
const ctx = canvas.getContext('2d');
const slider = document.getElementById('speedSlider');

// Globals
let maze = new Maze();
let appState = {
    algorithm: 'BFS',
    generator: null,
    state: "RUNNING",
    currentMazeKey: '50x50',
    wall_thickness: 2,
    inset: 2,
    frameCounter: 0
};

// Colors mapping
const COLOR_BG = "#FFFFFF";
const COLOR_WALL = "#000000";
const COLOR_DEAD = "#B7B7A4";
const COLOR_VISITED = "#DCDCDC";
const COLOR_BFS_VISITED = "#FFD778";
const COLOR_PATH = "#006400";
const COLOR_DFS_PATH = "#6495ED";
const COLOR_JUNCTION = "#FFB900";

const THREAD_COLORS = {
    0: "#FF7878", 1: "#DC3C3C", 2: "#B40000",
    3: "#78C8FF", 4: "#3C8CDC", 5: "#0000B4"
};

const PRUNE_COLORS = {
    0: "#FFC0C6", 1: "#F0A490", 2: "#93EE93", 3: "#ADD8E6"
};

const MAZE_FILES = {
    "20x20": "Maze_Data/Maze20x20.data",
    "50x50": "Maze_Data/Maze50x50.data",
    "100x100": "Maze_Data/Maze100x100.data",
    "200x200": "Maze_Data/Maze200x200.data"
};

async function initSolver() {
    maze.Reset();
    let solver;
    if (appState.algorithm === 'BFS') solver = new BFSSolver(maze);
    else if (appState.algorithm === 'DFS') solver = new DFSSolver(maze);
    else if (appState.algorithm === 'MT_M2') solver = new MTSolver(maze);
    else if (appState.algorithm === 'MT_M1') solver = new MT_M1_Solver(maze);

    appState.generator = solver.solve_step_by_step();
    appState.state = "RUNNING";
    document.getElementById('status').textContent = `Running ${appState.algorithm}...`;
}

async function loadMaze(key) {
    document.querySelectorAll('#size-btns button').forEach(b => b.classList.remove('active'));
    // Highlight clicked (simple logic for now, hardcoded active in HTML for init)

    appState.currentMazeKey = key;
    try {
        await maze.Load(MAZE_FILES[key]);

        // Visual Settings
        if (maze.width >= 200) { appState.wall_thickness = 1; appState.inset = 0; }
        else if (maze.width >= 100) { appState.wall_thickness = 1; appState.inset = 1; }
        else { appState.wall_thickness = 2; appState.inset = 2; }

        initSolver();
    } catch (e) {
        console.error(e);
        alert("Failed to load maze data. Check console.");
    }
}

function setAlgo(name) {
    document.querySelectorAll('#algo-btns button').forEach(b => b.classList.remove('active'));
    appState.algorithm = name;
    initSolver();
}

function restart() {
    initSolver();
}

// Draw Function
function draw() {
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (maze.width === 0) return;

    const stepX = canvas.width / maze.width;
    const stepY = canvas.height / maze.height;
    const inset = appState.inset;
    const wt = appState.wall_thickness;

    for (let r = 0; r < maze.height; r++) {
        const y = Math.floor(r * stepY);
        const h = Math.floor((r + 1) * stepY) - y;

        for (let c = 0; c < maze.width; c++) {
            const x = Math.floor(c * stepX);
            const w = Math.floor((c + 1) * stepX) - x;

            const pos = new Position(r, c);
            const val = maze.getCell(pos);
            if (val === 0) continue;

            const fw = Math.max(1, w - 2 * inset);
            const fh = Math.max(1, h - 2 * inset);
            const fillX = x + inset;
            const fillY = y + inset;

            // Flags
            const is_path = (val & InternalBit.PATH_BIT);
            const is_visited = (val & InternalBit.VISITED_BIT);
            const on_stack = (val & InternalBit.ON_STACK_BIT);
            const is_dead_junction = (val & InternalBit.DEAD_JUNCTION_BIT);
            const is_pruned = (val & InternalBit.PRUNED_BIT);

            let color = null;

            if (is_path) color = COLOR_PATH;
            else if (appState.algorithm === 'MT_M1' && is_pruned) {
                const tid = maze.getThreadOwner(pos);
                color = PRUNE_COLORS[tid] || COLOR_DEAD;
            }
            else if (is_dead_junction) color = COLOR_DEAD;
            else if (maze.isJunction(pos) && (is_visited || on_stack || (val & (InternalBit.VISITED_TB | InternalBit.VISITED_BT)))) {
                color = COLOR_JUNCTION;
            }
            // MT_M1 Coloring
            else if (appState.algorithm === 'MT_M1') {
                if (val & InternalBit.VISITED_TB) color = "#32CD32"; // Lime
                else if (val & InternalBit.VISITED_BT) color = "#FFD700"; // Gold
                else if (val & InternalBit.VISITED_BIT) color = COLOR_VISITED;
            }
            // MT_M2 Coloring
            else if (appState.algorithm === 'MT_M2') {
                const tid = maze.getThreadOwner(pos);
                if ((val & InternalBit.VISITED_TB) || (val & InternalBit.VISITED_BT)) {
                    color = THREAD_COLORS[tid] || "#999";
                } else if (val & InternalBit.VISITED_BIT) {
                    color = COLOR_VISITED;
                }
            }
            // DFS
            else if (appState.algorithm === 'DFS') {
                if (on_stack) color = COLOR_DFS_PATH;
                else if (is_visited) color = COLOR_VISITED;
            }
            // BFS
            else if (is_visited) {
                color = (appState.algorithm === 'BFS') ? COLOR_BFS_VISITED : COLOR_VISITED;
            }

            if (color) {
                ctx.fillStyle = color;
                ctx.fillRect(fillX, fillY, fw, fh);
            }

            // Walls
            ctx.fillStyle = COLOR_WALL;
            if (val & InternalBit.EAST_BIT) {
                ctx.fillRect(x + w - wt, y, wt, h);
            }
            if (val & InternalBit.SOUTH_BIT) {
                ctx.fillRect(x, y + h - wt, w, wt);
            }
        }
    }
}

// Animation Loop
function loop() {
    const val = parseInt(slider.value);

    if (appState.state !== "FINISHED" && appState.state !== "NO_SOLUTION") {
        if (val < 0) {
            // Slow down
            appState.frameCounter++;
            if (appState.frameCounter > Math.abs(val)) {
                appState.frameCounter = 0;
                try {
                    const res = appState.generator.next();
                    appState.state = res.done ? "FINISHED" : (res.value || "RUNNING");
                } catch (e) { appState.state = "FINISHED"; }
            }
        } else {
            // Speed up
            const steps = val + 1;
            for (let i = 0; i < steps; i++) {
                try {
                    const res = appState.generator.next();
                    appState.state = res.done ? "FINISHED" : (res.value || "RUNNING");
                    if (appState.state === "FINISHED") break;
                } catch (e) { appState.state = "FINISHED"; break; }
            }
        }
    }

    draw();
    requestAnimationFrame(loop);
}

// Start
loadMaze('50x50');
loop();