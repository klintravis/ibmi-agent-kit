**free
// SEEDSRV - seed stock service program (demo)
ctl-opt nomain option(*srcstmt:*nodebugio);

// closed after each call: the caller's activation group may outlive it; SEED-CLEAN deletes SEEDS
dcl-f SEEDS disk keyed usage(*input) qualified usropn;

/copy SEEDSRC,SEEDPR

dcl-proc SeedGet export;
  dcl-pi *n ind;
    id packed(5:0) const;
    seed likeds(Seed_t);
  end-pi;
  dcl-ds rec likerec(SEEDS.SEEDREC);
  dcl-s found ind;

  openFile();
  chain (id) SEEDS.SEEDREC rec;
  found = %found(SEEDS);
  close SEEDS;
  clear seed;
  if found;
    seed.id = rec.SEEDID;
    seed.name = rec.SEEDNAME;
    seed.qty = rec.SEEDQTY;
  endif;
  return found;
end-proc;

dcl-proc SeedCount export;
  dcl-pi *n int(10) end-pi;
  dcl-ds rec likerec(SEEDS.SEEDREC);
  dcl-s n int(10);

  openFile();
  setll *loval SEEDS;
  read SEEDS.SEEDREC rec;
  dow not %eof(SEEDS);
    n += 1;
    read SEEDS.SEEDREC rec;
  enddo;
  close SEEDS;
  return n;
end-proc;

dcl-proc SeedStatus export;
  dcl-pi *n varchar(10);
    qty packed(7:0) const;
  end-pi;

  select;
    when qty <= 0;
      return 'Sold out';
    when qty <= 24;
      return 'Low';
    when qty <= 500;
      return 'In stock';
    other;
      return 'Overstock';
  endsl;
end-proc;

dcl-proc openFile;
  if not %open(SEEDS);
    open SEEDS;
  endif;
end-proc;
