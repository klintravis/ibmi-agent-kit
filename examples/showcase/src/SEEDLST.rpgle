**free
// SEEDLST - seed stock list with a subfile (demo)
ctl-opt option(*srcstmt:*nodebugio);

dcl-f SEEDDSPF workstn sfile(SEEDSFL:rrn);
// block(*no): F5 rereads the file and must see rows added since the last load
dcl-f SEEDS disk keyed usage(*input) qualified block(*no);

/copy SEEDSRC,SEEDPR

dcl-s rrn packed(4:0);
dcl-ds rec likerec(SEEDS.SEEDREC);

loadSubfile();
dow not *in03;
  write SEEDFTR;
  exfmt SEEDCTL;
  if *in03;
    leave;
  endif;
  if *in05;
    *in05 = *off;
    loadSubfile();
    iter;
  endif;
  processOptions();
enddo;

*inlr = *on;
return;

dcl-proc loadSubfile;
  *in31 = *off;
  *in32 = *off;
  *in33 = *on;
  write SEEDCTL;
  *in33 = *off;

  rrn = 0;
  setll *loval SEEDS;
  read SEEDS.SEEDREC rec;
  dow not %eof(SEEDS) and rrn < 50;
    rrn += 1;
    OPT = ' ';
    SSEEDID = rec.SEEDID;
    SSEEDNAME = rec.SEEDNAME;
    SSEEDQTY = rec.SEEDQTY;
    SSTATUS = SeedStatus(rec.SEEDQTY);
    write SEEDSFL;
    read SEEDS.SEEDREC rec;
  enddo;

  *in31 = (rrn > 0);
  *in32 = *on;
  *in34 = *on;
  if rrn > 0;
    RRN1 = 1;
    MSG = %char(SeedCount()) + ' seeds.';
  else;
    RRN1 = 0;
    MSG = 'No seeds found.';
  endif;
end-proc;

dcl-proc processOptions;
  if rrn = 0;
    return;
  endif;
  readc SEEDSFL;
  dow not %eof(SEEDDSPF);
    if OPT = '5';
      showDetail(SSEEDID);
      OPT = ' ';
      update SEEDSFL;
    endif;
    if *in03;
      return;
    endif;
    readc SEEDSFL;
  enddo;
end-proc;

dcl-proc showDetail;
  dcl-pi *n;
    id packed(5:0) const;
  end-pi;
  dcl-ds seed likeds(Seed_t);

  if not SeedGet(id: seed);
    MSG = 'Seed ' + %char(id) + ' not found.';
    return;
  endif;
  DSEEDID = seed.id;
  DSEEDNAME = seed.name;
  DSEEDQTY = seed.qty;
  DSTATUS = SeedStatus(seed.qty);
  exfmt SEEDDTL;
  *in12 = *off;
end-proc;
