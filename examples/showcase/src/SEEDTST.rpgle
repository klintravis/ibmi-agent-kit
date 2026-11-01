**free
// SEEDTST - unit tests for SEEDSRV; ends with an escape message on any failure
ctl-opt option(*srcstmt:*nodebugio);

/copy SEEDSRC,SEEDPR

dcl-pr QMHSNDPM extpgm('QMHSNDPM');
  msgId char(7) const;
  msgFile char(20) const;
  msgData char(256) const options(*varsize);
  msgDataLen int(10) const;
  msgType char(10) const;
  callStack char(10) const;
  callStackCtr int(10) const;
  msgKey char(4);
  errorCode char(8);
end-pr;

dcl-s passed int(10);
dcl-s failed int(10);
dcl-s failures varchar(200);
dcl-s found ind;
dcl-ds seed likeds(Seed_t);

assertEq('status 0': SeedStatus(0): 'Sold out');
assertEq('status 1': SeedStatus(1): 'Low');
assertEq('status 24': SeedStatus(24): 'Low');
assertEq('status 25': SeedStatus(25): 'In stock');
assertEq('status 500': SeedStatus(500): 'In stock');
assertEq('status 501': SeedStatus(501): 'Overstock');

found = SeedGet(3: seed);
assertTrue('get 3 is Tomato': found and %trim(seed.name) = 'Tomato');
assertTrue('get 99 missing': not SeedGet(99: seed));
assertTrue('count is 8': SeedCount() = 8);

report();
*inlr = *on;
return;

dcl-proc assertEq;
  dcl-pi *n;
    name varchar(30) const;
    actual varchar(50) const;
    expected varchar(50) const;
  end-pi;
  assertTrue(name: actual = expected);
end-proc;

dcl-proc assertTrue;
  dcl-pi *n;
    name varchar(30) const;
    ok ind const;
  end-pi;
  if ok;
    passed += 1;
  else;
    failed += 1;
    if %len(failures) + %len(name) < 190;
      failures += ' ' + name + ';';
    endif;
  endif;
end-proc;

dcl-proc report;
  dcl-s text varchar(256);
  dcl-s key char(4);
  dcl-s err char(8) inz(*allx'00');

  text = 'SEEDTST: ' + %char(passed) + ' passed, ' + %char(failed) + ' failed';
  if failed > 0;
    text += '. Failed:' + failures;
    QMHSNDPM('CPF9898': 'QCPFMSG   *LIBL': text: %len(text): '*ESCAPE': '*PGMBDY': 1: key: err);
  else;
    QMHSNDPM('CPF9898': 'QCPFMSG   *LIBL': text: %len(text): '*COMP': '*PGMBDY': 1: key: err);
  endif;
end-proc;
